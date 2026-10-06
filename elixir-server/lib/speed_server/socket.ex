defmodule SpeedServer.Socket do
  @moduledoc """
  WebSocket speed-test handler. See ../../README.md for the protocol.
  Text frames starting with "@" are control messages; everything else is echoed
  (echo mode) or ignored (generate mode).
  """
  @behaviour WebSock

  alias SpeedServer.Stats

  @batch 100

  @impl true
  def init(_) do
    Stats.connected()
    {:ok, %{mode: :echo}}
  end

  @impl true
  def terminate(_reason, _state) do
    Stats.disconnected()
    :ok
  end

  @impl true
  def handle_in({"@" <> json, [opcode: :text]}, state) do
    case Jason.decode(json) do
      {:ok, %{"cmd" => cmd} = msg} when cmd in ["info", "mode"] ->
        state =
          case {cmd, msg["mode"]} do
            {"mode", "echo"} -> %{state | mode: :echo}
            {"mode", "generate"} -> %{state | mode: :generate}
            _ -> state
          end

        info = %{
          evt: "info",
          server: "elixir",
          runtime: "Elixir #{System.version()} / OTP #{:erlang.system_info(:otp_release)} Bandit",
          mode: Atom.to_string(state.mode)
        }

        {:push, {:text, "@" <> Jason.encode!(info)}, state}

      {:ok, %{"cmd" => "stats"}} ->
        {:push, {:text, "@" <> Jason.encode!(Stats.snapshot())}, state}

      {:ok, %{"cmd" => "start"} = msg} when state.mode == :generate ->
        count = max(msg["count"] || 0, 0)
        size = max(msg["size"] || 0, 0)
        send(self(), {:gen, 0, count, String.duplicate("x", size), size, System.monotonic_time()})
        {:ok, state}

      _ ->
        {:ok, state}
    end
  end

  def handle_in({data, [opcode: opcode]}, %{mode: :echo} = state) do
    Stats.msg_in()
    Stats.msg_out()
    {:push, {opcode, data}, state}
  end

  def handle_in({_data, [opcode: opcode]}, state) when opcode in [:text, :binary] do
    Stats.msg_in()
    {:ok, state}
  end

  def handle_in(_, state), do: {:ok, state}

  @impl true
  def handle_info({:gen, i, count, pad, size, t0}, state) when i < count do
    last = min(i + @batch, count)
    frames = for n <- i..(last - 1)//1, do: {:text, [Integer.to_string(n), "|", pad]}
    send(self(), {:gen, last, count, pad, size, t0})
    Stats.msg_out(last - i)
    {:push, frames, state}
  end

  def handle_info({:gen, _i, count, _pad, size, t0}, state) do
    server_ms = System.convert_time_unit(System.monotonic_time() - t0, :native, :microsecond) / 1000
    done = %{evt: "done", count: count, size: size, serverMs: server_ms}
    {:push, {:text, "@" <> Jason.encode!(done)}, state}
  end

  def handle_info(_, state), do: {:ok, state}
end
