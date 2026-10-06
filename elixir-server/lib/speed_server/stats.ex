defmodule SpeedServer.Stats do
  @moduledoc "Process-wide counters and the snapshot returned for the `stats` command."

  # counter slots
  @connections 1
  @msgs_in 2
  @msgs_out 3

  def init do
    :persistent_term.put(__MODULE__, :counters.new(3, [:write_concurrency]))
    :persistent_term.put({__MODULE__, :started}, System.monotonic_time(:millisecond))
  end

  defp c, do: :persistent_term.get(__MODULE__)

  def connected, do: :counters.add(c(), @connections, 1)
  def disconnected, do: :counters.sub(c(), @connections, 1)
  def msg_in(n \\ 1), do: :counters.add(c(), @msgs_in, n)
  def msg_out(n \\ 1), do: :counters.add(c(), @msgs_out, n)

  @mb 1_048_576

  def snapshot do
    mem = :erlang.memory()
    {rss_kb, threads} = os_stats()
    {cpu_ms, _} = :erlang.statistics(:runtime)
    started = :persistent_term.get({__MODULE__, :started})

    %{
      evt: "stats",
      server: "elixir",
      pid: System.pid() |> String.to_integer(),
      uptimeS: (System.monotonic_time(:millisecond) - started) / 1000,
      cpuCores: System.schedulers_online(),
      rssMB: rss_kb && rss_kb / 1024,
      heapMB: mem[:total] / @mb,
      threads: threads,
      processes: :erlang.system_info(:process_count),
      connections: :counters.get(c(), @connections),
      msgsIn: :counters.get(c(), @msgs_in),
      msgsOut: :counters.get(c(), @msgs_out),
      cpuMs: cpu_ms,
      extra: %{
        schedulers: :erlang.system_info(:schedulers_online),
        dirtyCpuSchedulers: :erlang.system_info(:dirty_cpu_schedulers_online),
        runQueue: :erlang.statistics(:run_queue),
        ports: :erlang.system_info(:port_count),
        beamProcessesMB: mem[:processes] / @mb,
        beamBinaryMB: mem[:binary] / @mb,
        beamEtsMB: mem[:ets] / @mb,
        beamCodeMB: mem[:code] / @mb,
        gcCount: elem(:erlang.statistics(:garbage_collection), 0),
        reductions: elem(:erlang.statistics(:reductions), 0)
      }
    }
  end

  # Resident memory (KB) and OS thread count via `ps`, matching the other servers.
  defp os_stats do
    pid = System.pid()
    rss = ps(["-o", "rss=", "-p", pid]) |> parse_int()

    threads =
      case :os.type() do
        {:unix, :linux} ->
          case File.read("/proc/self/status") do
            {:ok, t} ->
              case Regex.run(~r/Threads:\s+(\d+)/, t) do
                [_, n] -> String.to_integer(n)
                _ -> nil
              end

            _ ->
              nil
          end

        _ ->
          case ps(["-M", "-p", pid]) do
            nil -> nil
            out -> max(length(String.split(out, "\n", trim: true)) - 1, 0)
          end
      end

    {rss, threads}
  end

  defp ps(args) do
    case System.cmd("ps", args, stderr_to_stdout: true) do
      {out, 0} -> out
      _ -> nil
    end
  rescue
    _ -> nil
  end

  defp parse_int(nil), do: nil

  defp parse_int(s) do
    case Integer.parse(String.trim(s)) do
      {n, _} -> n
      :error -> nil
    end
  end
end
