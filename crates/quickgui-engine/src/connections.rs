//! Explicit, bounded connection diagnostics. Nothing starts at project load.
use crate::JsonMap;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_serial::SerialPortBuilderExt;

const LIMIT: usize = 65_535;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub protocol: String,
    #[serde(default)]
    pub config: JsonMap,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub connection_id: String,
    pub protocol: String,
    pub latency_ms: u64,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub received: String,
    pub details: String,
}
struct Reply {
    sent: usize,
    bytes: Vec<u8>,
    details: String,
}

fn text<'a>(connection: &'a Connection, key: &str) -> &'a str {
    connection
        .config
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
}
fn integer(connection: &Connection, key: &str, default: u64) -> Result<u64, String> {
    match connection.config.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .ok_or_else(|| format!("{key} must be a nonnegative integer")),
    }
}
fn boolean(connection: &Connection, key: &str, default: bool) -> bool {
    connection
        .config
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(default)
}
fn message(connection: &Connection) -> Result<Vec<u8>, String> {
    let bytes = text(connection, "message").as_bytes().to_vec();
    if bytes.len() > LIMIT {
        return Err("Diagnostic message exceeds 65535 bytes".into());
    }
    Ok(bytes)
}
fn endpoint(connection: &Connection, scheme: &str) -> Result<(String, u16), String> {
    if !text(connection, "url").is_empty() {
        let url = url::Url::parse(text(connection, "url")).map_err(|_| "Invalid connection URL")?;
        if url.scheme() != scheme {
            return Err(format!("Expected {scheme}:// URL"));
        }
        return Ok((
            url.host_str().ok_or("URL has no host")?.to_owned(),
            url.port().ok_or("URL needs an explicit port")?,
        ));
    }
    let host = text(connection, "address");
    if host.is_empty() {
        return Err("Connection address is required".into());
    }
    let port = integer(connection, "port", 0)?;
    if port == 0 || port > 65535 {
        return Err("Port must be between 1 and 65535".into());
    }
    Ok((host.into(), port as u16))
}

pub async fn test_connection(connection: Connection) -> Result<ConnectionTestResult, String> {
    let timeout_ms = integer(&connection, "timeoutMs", 3000)?.clamp(100, 15_000);
    let start = Instant::now();
    let operation = async {
        match connection.protocol.as_str() {
            "http" => http(&connection).await,
            "websocket" => websocket(&connection).await,
            "mqtt" => mqtt(&connection).await,
            "tcp" => {
                let (host, port) = endpoint(&connection, "tcp")?;
                let mut stream = tokio::net::TcpStream::connect((host.as_str(), port))
                    .await
                    .map_err(|e| format!("TCP connect failed: {e}"))?;
                exchange(&mut stream, &connection, "TCP connected").await
            }
            "serial" => {
                let address = text(&connection, "address");
                if address.is_empty() {
                    return Err("Serial address (device path or COM name) is required".into());
                }
                let baud = integer(&connection, "baudRate", 115200)?;
                if baud == 0 || baud > 4_000_000 {
                    return Err("baudRate must be between 1 and 4000000".into());
                }
                let _lease = crate::serial::PortLease::acquire(address)
                    .map_err(|error| error.to_string())?;
                let mut port = tokio_serial::new(address, baud as u32)
                    .timeout(Duration::from_millis(timeout_ms))
                    .open_native_async()
                    .map_err(|e| format!("Serial open failed: {e}"))?;
                exchange(
                    &mut port,
                    &connection,
                    "Serial port opened (8N1, no flow control)",
                )
                .await
            }
            other => Err(format!("Unsupported connection protocol: {other}")),
        }
    };
    let reply = tokio::time::timeout(Duration::from_millis(timeout_ms), operation)
        .await
        .map_err(|_| {
            format!(
                "{} test timed out after {timeout_ms} ms",
                connection.protocol
            )
        })??;
    Ok(ConnectionTestResult {
        connection_id: connection.id,
        protocol: connection.protocol,
        latency_ms: start.elapsed().as_millis() as u64,
        bytes_sent: reply.sent as u64,
        bytes_received: reply.bytes.len() as u64,
        received: String::from_utf8_lossy(&reply.bytes).into_owned(),
        details: reply.details,
    })
}

async fn exchange<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    connection: &Connection,
    details: &str,
) -> Result<Reply, String> {
    let payload = message(connection)?;
    let framing = match text(connection, "framing") {
        "" => "raw",
        s => s,
    };
    let mut outgoing = Vec::new();
    match framing {
        "raw" => outgoing.extend_from_slice(&payload),
        "line" => {
            outgoing.extend_from_slice(&payload);
            if !payload.is_empty() && !payload.ends_with(b"\n") {
                outgoing.push(b'\n');
            }
        }
        "length16" => {
            if !payload.is_empty() {
                outgoing.extend_from_slice(&(payload.len() as u16).to_be_bytes());
                outgoing.extend_from_slice(&payload);
            }
        }
        _ => return Err("framing must be raw, line, or length16".into()),
    }
    if !outgoing.is_empty() {
        stream
            .write_all(&outgoing)
            .await
            .map_err(|e| format!("Send failed: {e}"))?;
        stream.flush().await.map_err(|e| e.to_string())?;
    }
    let should_read = boolean(connection, "expectReply", !payload.is_empty())
        || boolean(connection, "listen", false);
    let mut bytes = Vec::new();
    if should_read {
        match framing {
            "raw" => {
                bytes.resize(LIMIT, 0);
                let n = stream
                    .read(&mut bytes)
                    .await
                    .map_err(|e| format!("Receive failed: {e}"))?;
                if n == 0 {
                    return Err("Peer closed before a response".into());
                }
                bytes.truncate(n);
            }
            "line" => loop {
                let byte = stream
                    .read_u8()
                    .await
                    .map_err(|e| format!("Incomplete line: {e}"))?;
                bytes.push(byte);
                if byte == b'\n' {
                    break;
                }
                if bytes.len() >= LIMIT {
                    return Err("Received line exceeds 65535 bytes".into());
                }
            },
            "length16" => {
                let n = stream
                    .read_u16()
                    .await
                    .map_err(|e| format!("Incomplete length header: {e}"))?
                    as usize;
                bytes.resize(n, 0);
                stream
                    .read_exact(&mut bytes)
                    .await
                    .map_err(|e| format!("Incomplete frame: {e}"))?;
            }
            _ => unreachable!(),
        }
    }
    Ok(Reply {
        sent: outgoing.len(),
        bytes,
        details: details.into(),
    })
}

async fn http(connection: &Connection) -> Result<Reply, String> {
    let url = url::Url::parse(text(connection, "url")).map_err(|_| "HTTP requires a valid URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("HTTP URL must use http or https".into());
    }
    let method = match text(connection, "method") {
        "" => reqwest::Method::GET,
        s => reqwest::Method::from_bytes(s.as_bytes()).map_err(|_| "Invalid HTTP method")?,
    };
    let payload = message(connection)?;
    let sent = payload.len();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.request(method, url).body(payload);
    if let Some(headers) = connection.config.get("headers").and_then(Value::as_object) {
        for (key, value) in headers {
            request = request.header(
                key,
                value.as_str().ok_or("HTTP header values must be strings")?,
            );
        }
    }
    let mut response = request
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e.without_url()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP returned status {status}"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| e.without_url().to_string())?
    {
        if bytes.len() + chunk.len() > LIMIT {
            return Err("HTTP response exceeds 65535 bytes".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Reply {
        sent,
        bytes,
        details: format!("HTTP {status}"),
    })
}

async fn websocket(connection: &Connection) -> Result<Reply, String> {
    use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};
    let url = text(connection, "url");
    if !url.starts_with("ws://") && !url.starts_with("wss://") {
        return Err("WebSocket URL must use ws or wss".into());
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(LIMIT))
        .max_frame_size(Some(LIMIT));
    let (mut socket, response) =
        tokio_tungstenite::connect_async_with_config(url, Some(config), false)
            .await
            .map_err(|e| format!("WebSocket connect failed: {e}"))?;
    let payload = message(connection)?;
    let sent = payload.len();
    if !payload.is_empty() {
        socket
            .send(Message::Text(String::from_utf8(payload).unwrap().into()))
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut bytes = Vec::new();
    if boolean(connection, "expectReply", sent > 0) || boolean(connection, "listen", false) {
        loop {
            match socket
                .next()
                .await
                .ok_or("WebSocket closed before a response")?
                .map_err(|e| e.to_string())?
            {
                Message::Text(value) => {
                    bytes = value.as_bytes().to_vec();
                    break;
                }
                Message::Binary(value) => {
                    bytes = value.to_vec();
                    break;
                }
                Message::Ping(value) => socket
                    .send(Message::Pong(value))
                    .await
                    .map_err(|e| e.to_string())?,
                Message::Close(_) => return Err("WebSocket closed before a response".into()),
                _ => {}
            }
        }
    }
    let _ = socket.close(None).await;
    Ok(Reply {
        sent,
        bytes,
        details: format!("WebSocket {}", response.status()),
    })
}

async fn mqtt(connection: &Connection) -> Result<Reply, String> {
    use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS, Transport};
    let url = url::Url::parse(text(connection, "url"))
        .map_err(|_| "MQTT requires mqtt(s)://host:port")?;
    if !matches!(url.scheme(), "mqtt" | "mqtts") {
        return Err("MQTT URL must use mqtt or mqtts".into());
    }
    let host = url.host_str().ok_or("MQTT URL has no host")?;
    let port = url
        .port()
        .unwrap_or(if url.scheme() == "mqtts" { 8883 } else { 1883 });
    let id = format!("quickgui-test-{}-{}", std::process::id(), crate::now_ms());
    let mut options = MqttOptions::new(id, host, port);
    options
        .set_keep_alive(Duration::from_secs(10))
        .set_max_packet_size(LIMIT, LIMIT);
    if url.scheme() == "mqtts" {
        options.set_transport(Transport::tls_with_default_config());
    }
    if !text(connection, "username").is_empty() {
        options.set_credentials(text(connection, "username"), text(connection, "password"));
    }
    let (client, mut events) = AsyncClient::new(options, 8);
    loop {
        if let Event::Incoming(Packet::ConnAck(_)) = events
            .poll()
            .await
            .map_err(|e| format!("MQTT connect failed: {e}"))?
        {
            break;
        }
    }
    let topic = text(connection, "topic");
    let payload = connection.config.get("payload").map(|v| {
        v.as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| v.to_string())
    });
    let action = match text(connection, "action") {
        "" if payload.is_some() => "publish",
        "" if !topic.is_empty() => "subscribe",
        "" => "connect",
        s => s,
    };
    if action == "connect" {
        return Ok(Reply {
            sent: 0,
            bytes: Vec::new(),
            details: "MQTT CONNACK received".into(),
        });
    }
    if topic.is_empty() || topic.len() > 1024 {
        return Err("MQTT topic must contain 1..1024 bytes".into());
    }
    match action {
        "publish" => {
            let payload = payload.unwrap_or_default().into_bytes();
            if payload.len() > LIMIT {
                return Err("MQTT payload exceeds 65535 bytes".into());
            }
            let sent = payload.len();
            client
                .publish(topic, QoS::AtLeastOnce, false, payload)
                .await
                .map_err(|e| e.to_string())?;
            loop {
                if let Event::Incoming(Packet::PubAck(_)) =
                    events.poll().await.map_err(|e| e.to_string())?
                {
                    return Ok(Reply {
                        sent,
                        bytes: Vec::new(),
                        details: "MQTT QoS1 PUBACK received".into(),
                    });
                }
            }
        }
        "subscribe" => {
            client
                .subscribe(topic, QoS::AtMostOnce)
                .await
                .map_err(|e| e.to_string())?;
            loop {
                if let Event::Incoming(Packet::Publish(packet)) =
                    events.poll().await.map_err(|e| e.to_string())?
                {
                    if packet.payload.len() > LIMIT {
                        return Err("MQTT response exceeds 65535 bytes".into());
                    }
                    return Ok(Reply {
                        sent: 0,
                        bytes: packet.payload.to_vec(),
                        details: format!("MQTT message on {}", packet.topic),
                    });
                }
            }
        }
        _ => Err("MQTT action must be connect, publish, or subscribe".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::net::TcpListener;
    async fn mqtt_packet(s: &mut tokio::net::TcpStream) -> (u8, Vec<u8>) {
        let kind = s.read_u8().await.unwrap();
        let mut length = 0usize;
        let mut multiplier = 1;
        loop {
            let b = s.read_u8().await.unwrap();
            length += ((b & 127) as usize) * multiplier;
            if b & 128 == 0 {
                break;
            }
            multiplier *= 128;
            assert!(multiplier <= 128 * 128 * 128);
        }
        let mut bytes = vec![0; length];
        s.read_exact(&mut bytes).await.unwrap();
        (kind, bytes)
    }
    #[tokio::test]
    async fn mqtt_loopback_waits_for_actual_publish_ack() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            assert_eq!(mqtt_packet(&mut s).await.0, 0x10);
            s.write_all(&[0x20, 2, 0, 0]).await.unwrap();
            let (kind, data) = mqtt_packet(&mut s).await;
            assert_eq!(kind, 0x32);
            let size = u16::from_be_bytes([data[0], data[1]]) as usize;
            assert_eq!(&data[2..2 + size], b"quickgui/test");
            assert_eq!(&data[4 + size..], b"hello");
            s.write_all(&[0x40, 2, data[2 + size], data[3 + size]])
                .await
                .unwrap();
            // A broker keeps the connection alive after PUBACK. Wait for the
            // diagnostic client to close instead of racing its packet decoder.
            let mut closing = [0u8; 2];
            let _ = s.read(&mut closing).await;
        });
        let result=test_connection(connection("mqtt",json!({"url":format!("mqtt://127.0.0.1:{port}"),"topic":"quickgui/test","payload":"hello","action":"publish"}))).await.unwrap();
        assert_eq!(result.bytes_sent, 5);
        assert!(result.details.contains("PUBACK"));
        server.await.unwrap();
    }
    fn connection(protocol: &str, config: Value) -> Connection {
        Connection {
            id: "test".into(),
            name: "Local test".into(),
            protocol: protocol.into(),
            config: serde_json::from_value(config).unwrap(),
        }
    }
    #[tokio::test]
    async fn tcp_loopback_round_trip_with_fragmented_length_frame() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let len = s.read_u16().await.unwrap();
            let mut msg = vec![0; len as usize];
            s.read_exact(&mut msg).await.unwrap();
            assert_eq!(msg, b"ping");
            s.write_all(&[0]).await.unwrap();
            s.write_all(&[4, b'p', b'o']).await.unwrap();
            s.write_all(b"ng").await.unwrap();
        });
        let result = test_connection(connection(
            "tcp",
            json!({"address":"127.0.0.1","port":port,"message":"ping","framing":"length16"}),
        ))
        .await
        .unwrap();
        assert_eq!(result.received, "pong");
        assert_eq!(result.bytes_sent, 6);
        server.await.unwrap();
    }
    #[tokio::test]
    async fn http_loopback_returns_actual_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut bytes = [0u8; 4096];
            let n = s.read(&mut bytes).await.unwrap();
            assert!(String::from_utf8_lossy(&bytes[..n]).starts_with("GET /health"));
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
        });
        let result = test_connection(connection(
            "http",
            json!({"url":format!("http://127.0.0.1:{port}/health")}),
        ))
        .await
        .unwrap();
        assert_eq!(result.received, "ok");
        server.await.unwrap();
    }
    #[tokio::test]
    async fn websocket_loopback_exchanges_a_real_frame() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
            let message = ws.next().await.unwrap().unwrap();
            ws.send(message).await.unwrap();
        });
        let result = test_connection(connection(
            "websocket",
            json!({"url":format!("ws://127.0.0.1:{port}"),"message":"hello"}),
        ))
        .await
        .unwrap();
        assert_eq!(result.received, "hello");
        server.await.unwrap();
    }
    #[tokio::test]
    async fn silent_peer_times_out_without_hanging_host() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (_s, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });
        let error = test_connection(connection(
            "tcp",
            json!({"address":"127.0.0.1","port":port,"message":"ping","timeoutMs":100}),
        ))
        .await
        .unwrap_err();
        assert!(error.contains("timed out"));
        server.abort();
    }
    #[tokio::test]
    async fn invalid_protocol_and_missing_serial_device_return_errors() {
        assert!(test_connection(connection("unsupported", json!({})))
            .await
            .is_err());
        assert!(test_connection(connection(
            "serial",
            json!({"address":"/quickgui-missing-device"})
        ))
        .await
        .unwrap_err()
        .contains("Serial open failed"));
    }
}
