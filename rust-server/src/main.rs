// WebSocket speed-test server (Rust + tokio-tungstenite). See ../README.md for the protocol.
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::Instant;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;

static CONNECTIONS: AtomicU64 = AtomicU64::new(0);
static MSGS_IN: AtomicU64 = AtomicU64::new(0);
static MSGS_OUT: AtomicU64 = AtomicU64::new(0);

/// Resident memory (KB) and OS thread count of this process, via `ps`.
fn os_stats() -> (Option<f64>, Option<u64>) {
    use std::process::Command;
    let pid = std::process::id().to_string();
    let rss = Command::new("ps").args(["-o", "rss=", "-p", &pid]).output().ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().ok());
    let threads = if cfg!(target_os = "linux") {
        std::fs::read_to_string("/proc/self/status").ok().and_then(|t| {
            t.lines().find_map(|l| l.strip_prefix("Threads:")?.trim().parse().ok())
        })
    } else {
        Command::new("ps").args(["-M", "-p", &pid]).output().ok()
            .map(|o| (String::from_utf8_lossy(&o.stdout).lines().count() as u64).saturating_sub(1))
    };
    (rss, threads)
}

/// Total CPU time (user + system) consumed by this process, in ms.
fn cpu_ms() -> f64 {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    let tv = |t: libc::timeval| t.tv_sec as f64 * 1000.0 + t.tv_usec as f64 / 1000.0;
    tv(ru.ru_utime) + tv(ru.ru_stime)
}

async fn stats(started: Instant) -> String {
    let (rss, threads) = tokio::task::spawn_blocking(os_stats).await.unwrap_or((None, None));
    let workers = tokio::runtime::Handle::current().metrics().num_workers();
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let v = serde_json::json!({
        "evt": "stats", "server": "rust", "pid": std::process::id(),
        "uptimeS": started.elapsed().as_secs_f64(), "cpuCores": cores,
        "rssMB": rss.map(|k| k / 1024.0), "heapMB": null, "threads": threads, "processes": null,
        "connections": CONNECTIONS.load(Relaxed), "msgsIn": MSGS_IN.load(Relaxed), "msgsOut": MSGS_OUT.load(Relaxed),
        "cpuMs": cpu_ms(),
        "extra": { "tokioWorkers": workers, "tokioAliveTasks": tokio::runtime::Handle::current().metrics().num_alive_tasks() }
    });
    format!("@{v}")
}

#[derive(PartialEq, Clone, Copy)]
enum Mode {
    Echo,
    Generate,
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8082);
    let listener = TcpListener::bind(("0.0.0.0", port)).await.expect("bind failed");
    let started = Instant::now();
    println!("rust server listening on ws://localhost:{port}/ws");
    while let Ok((stream, _)) = listener.accept().await {
        tokio::spawn(handle(stream, started));
    }
}

async fn handle(stream: TcpStream, started: Instant) {
    CONNECTIONS.fetch_add(1, Relaxed);
    serve(stream, started).await;
    CONNECTIONS.fetch_sub(1, Relaxed);
}

async fn serve(stream: TcpStream, started: Instant) {
    let _ = stream.set_nodelay(true);
    let cb = |req: &Request, resp: Response| {
        let _ = req;
        Ok(resp)
    };
    let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, cb).await else { return };
    let (mut tx, mut rx) = ws.split();
    let mut mode = Mode::Echo;

    while let Some(Ok(msg)) = rx.next().await {
        match msg {
            Message::Text(text) if text.as_bytes().first() == Some(&b'@') => {
                let Ok(cmd) = serde_json::from_str::<serde_json::Value>(&text[1..]) else { continue };
                match cmd["cmd"].as_str() {
                    Some("info") | Some("mode") => {
                        if cmd["cmd"] == "mode" {
                            match cmd["mode"].as_str() {
                                Some("echo") => mode = Mode::Echo,
                                Some("generate") => mode = Mode::Generate,
                                _ => {}
                            }
                        }
                        let info = serde_json::json!({
                            "evt": "info", "server": "rust", "runtime": "Rust tokio-tungstenite",
                            "mode": if mode == Mode::Echo { "echo" } else { "generate" }
                        });
                        if tx.send(Message::text(format!("@{info}"))).await.is_err() { return; }
                    }
                    Some("stats") => {
                        if tx.send(Message::text(stats(started).await)).await.is_err() { return; }
                    }
                    Some("start") if mode == Mode::Generate => {
                        let count = cmd["count"].as_u64().unwrap_or(0);
                        let size = cmd["size"].as_u64().unwrap_or(0) as usize;
                        if generate(&mut tx, count, size).await.is_err() { return; }
                    }
                    _ => {}
                }
            }
            Message::Text(_) | Message::Binary(_) => {
                MSGS_IN.fetch_add(1, Relaxed);
                if mode != Mode::Echo { continue; }
                MSGS_OUT.fetch_add(1, Relaxed);
                if tx.send(msg).await.is_err() { return; }
            }
            Message::Close(_) => return,
            _ => {}
        }
    }
}

async fn generate<S>(tx: &mut S, count: u64, size: usize) -> Result<(), S::Error>
where
    S: futures_util::Sink<Message> + Unpin,
{
    let pad = "x".repeat(size);
    let start = Instant::now();
    for i in 0..count {
        // feed() buffers; a flush happens automatically when the write buffer fills (backpressure).
        tx.feed(Message::text(format!("{i}|{pad}"))).await?;
    }
    MSGS_OUT.fetch_add(count, Relaxed);
    let server_ms = start.elapsed().as_secs_f64() * 1000.0;
    let done = serde_json::json!({ "evt": "done", "count": count, "size": size, "serverMs": server_ms });
    tx.send(Message::text(format!("@{done}"))).await
}
