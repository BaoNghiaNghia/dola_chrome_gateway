use crate::models::{ProxyCheckResult, ProxySettings};
use chrono::Utc;
use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::time::{Duration, Instant};

pub fn validate(settings: &ProxySettings) -> Result<(), String> {
    if !settings.enabled {
        return Ok(());
    }

    match settings.protocol.as_str() {
        "http" | "https" | "socks5" => {}
        _ => return Err("Proxy protocol must be HTTP, HTTPS, or SOCKS5.".into()),
    }

    if settings.host.trim().is_empty() {
        return Err("Proxy host is required while proxy is enabled.".into());
    }
    if settings.port == 0 {
        return Err("Proxy port is required while proxy is enabled.".into());
    }

    match settings.rotation_mode.as_str() {
        "sticky" | "rotate_on_launch" | "manual" => {}
        _ => return Err("Unsupported proxy rotation mode.".into()),
    }

    if settings.rotation_mode == "rotate_on_launch"
        && settings.rotation_url.as_deref().unwrap_or("").trim().is_empty()
    {
        return Err(
            "Rotate on launch requires a rotation URL. Use Sticky if your provider rotates through the endpoint itself."
                .into(),
        );
    }

    Ok(())
}

pub fn proxy_server_arg(settings: &ProxySettings) -> Result<Option<String>, String> {
    if !settings.enabled {
        return Ok(None);
    }
    validate(settings)?;
    Ok(Some(format!(
        "{}://{}:{}",
        settings.protocol,
        settings.host.trim(),
        settings.port
    )))
}

pub fn check(settings: &ProxySettings) -> Result<ProxyCheckResult, String> {
    validate(settings)?;

    if !settings.enabled {
        return Ok(ProxyCheckResult {
            reachable: true,
            public_ip: None,
            latency_ms: None,
            checked_at: Utc::now().to_rfc3339(),
            message: "Proxy is disabled.".into(),
        });
    }

    let address = format!("{}:{}", settings.host.trim(), settings.port);
    let mut addresses = address
        .to_socket_addrs()
        .map_err(|e| format!("Cannot resolve proxy host: {e}"))?;
    let socket = addresses
        .next()
        .ok_or_else(|| "Proxy host did not resolve to an address.".to_string())?;

    let started = Instant::now();
    TcpStream::connect_timeout(&socket, Duration::from_secs(8))
        .map_err(|e| format!("Proxy is unreachable: {e}"))?;
    let latency_ms = started.elapsed().as_millis() as u64;

    let public_ip = if settings.auth_username.is_none() {
        fetch_public_ip(settings).ok()
    } else {
        None
    };

    let message = if settings.auth_username.is_some() {
        "Proxy endpoint is reachable. Public IP check is skipped because authentication is handled by Chrome."
            .to_string()
    } else if let Some(ip) = public_ip.as_deref() {
        format!("Proxy is reachable. Public IP: {ip}")
    } else {
        "Proxy endpoint is reachable. Public IP check was unavailable.".to_string()
    };

    Ok(ProxyCheckResult {
        reachable: true,
        public_ip,
        latency_ms: Some(latency_ms),
        checked_at: Utc::now().to_rfc3339(),
        message,
    })
}

fn fetch_public_ip(settings: &ProxySettings) -> Result<String, String> {
    let proxy_url = format!(
        "{}://{}:{}",
        settings.protocol,
        settings.host.trim(),
        settings.port
    );

    let output = Command::new("curl")
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--connect-timeout",
            "8",
            "--max-time",
            "12",
            "--proxy",
            &proxy_url,
            "https://api.ipify.org",
        ])
        .output()
        .map_err(|e| format!("Cannot run proxy IP check: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if ip.is_empty() {
        return Err("Proxy IP check returned an empty response.".into());
    }
    Ok(ip)
}

pub fn rotate(settings: &ProxySettings) -> Result<(), String> {
    validate(settings)?;
    let url = settings
        .rotation_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "This proxy does not have a rotation URL configured.".to_string())?;

    let output = Command::new("curl")
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--connect-timeout",
            "8",
            "--max-time",
            "15",
            url,
        ])
        .output()
        .map_err(|e| format!("Cannot call proxy rotation endpoint: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if message.is_empty() {
            "Proxy rotation endpoint returned an error.".into()
        } else {
            message
        })
    }
}
