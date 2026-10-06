defmodule SpeedServer.Router do
  use Plug.Router

  plug :match
  plug :dispatch

  get "/ws" do
    conn
    |> WebSockAdapter.upgrade(SpeedServer.Socket, %{}, compress: false)
    |> halt()
  end

  match _ do
    send_resp(conn, 404, "not found")
  end
end
