defmodule SpeedServer.Application do
  use Application

  @impl true
  def start(_type, _args) do
    port = String.to_integer(System.get_env("PORT") || "8083")

    SpeedServer.Stats.init()

    children = [
      {Bandit, plug: SpeedServer.Router, scheme: :http, port: port}
    ]

    IO.puts("elixir server listening on ws://localhost:#{port}/ws")
    Supervisor.start_link(children, strategy: :one_for_one, name: SpeedServer.Supervisor)
  end
end
