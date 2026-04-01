use core::time::Duration;
use std::io::{Cursor, Write as _};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs as _};
use std::sync::Once;

use anyhow::{Context as _, Result};
use ironrdp::connector;
use ironrdp::connector::connection_activation::{
    ConnectionActivationSequence, ConnectionActivationState,
};
use ironrdp::connector::ConnectionResult;
use ironrdp::connector::Credentials;
use ironrdp::core::WriteBuf;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags as FastPathKeyboardFlags};
use ironrdp::pdu::input::mouse::{MousePdu, PointerFlags};
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::session::fast_path;
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageOutput};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use sspi::network_client::reqwest_network_client::ReqwestNetworkClient;
use tokio_rustls::rustls;

#[derive(Debug, Clone)]
pub struct RdpCaptureOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    pub width: u16,
    pub height: u16,
    pub timeout_seconds: u64,
    pub input_actions: Vec<RdpInputAction>,
}

#[derive(Debug, Clone)]
pub struct RdpCaptureImage {
    pub png_bytes: Vec<u8>,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RdpMouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RdpInputAction {
    MouseMove {
        x: u16,
        y: u16,
    },
    MouseClick {
        x: u16,
        y: u16,
        button: RdpMouseButton,
        #[serde(default)]
        double_click: bool,
    },
    KeyPress {
        code: String,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        ctrl: bool,
        #[serde(default)]
        alt: bool,
        #[serde(default)]
        shift: bool,
        #[serde(default)]
        meta: bool,
    },
}

type UpgradedFramed =
    ironrdp_blocking::Framed<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>;
static RUSTLS_PROVIDER_INIT: Once = Once::new();

fn ensure_rustls_crypto_provider() {
    RUSTLS_PROVIDER_INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

pub fn capture_png_once(options: RdpCaptureOptions) -> Result<RdpCaptureImage> {
    ensure_rustls_crypto_provider();

    let config = build_config(
        options.username.clone(),
        options.password.clone(),
        options.domain.clone(),
        options.width,
        options.height,
    )?;

    let (connection_result, framed) = connect(
        config,
        options.host.clone(),
        options.port,
        options.timeout_seconds,
    )
    .context("connect")?;

    let mut image = DecodedImage::new(
        PixelFormat::RgbA32,
        connection_result.desktop_size.width,
        connection_result.desktop_size.height,
    );

    active_stage(
        connection_result,
        framed,
        &mut image,
        &options.input_actions,
    )
    .context("active stage")?;

    let image_data = image.data().to_vec();
    let img: image::ImageBuffer<image::Rgba<u8>, _> = image::ImageBuffer::from_raw(
        u32::from(image.width()),
        u32::from(image.height()),
        image_data,
    )
    .context("invalid image")?;

    let mut png_bytes = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .context("encode PNG frame")?;

    Ok(RdpCaptureImage {
        png_bytes,
        width: image.width(),
        height: image.height(),
    })
}

fn build_config(
    username: String,
    password: String,
    domain: Option<String>,
    width: u16,
    height: u16,
) -> Result<connector::Config> {
    Ok(connector::Config {
        credentials: Credentials::UsernamePassword { username, password },
        domain,
        enable_tls: false,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: connector::DesktopSize { width, height },
        bitmap: None,
        client_build: 0,
        client_name: "termopen-rdp".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        #[cfg(windows)]
        platform: MajorPlatformType::WINDOWS,
        #[cfg(target_os = "macos")]
        platform: MajorPlatformType::MACINTOSH,
        #[cfg(target_os = "ios")]
        platform: MajorPlatformType::IOS,
        #[cfg(target_os = "linux")]
        platform: MajorPlatformType::UNIX,
        #[cfg(target_os = "android")]
        platform: MajorPlatformType::ANDROID,
        #[cfg(target_os = "freebsd")]
        platform: MajorPlatformType::UNIX,
        #[cfg(target_os = "dragonfly")]
        platform: MajorPlatformType::UNIX,
        #[cfg(target_os = "openbsd")]
        platform: MajorPlatformType::UNIX,
        #[cfg(target_os = "netbsd")]
        platform: MajorPlatformType::UNIX,
        enable_server_pointer: false,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        pointer_software_rendering: true,
        performance_flags: PerformanceFlags::default(),
        desktop_scale_factor: 0,
        hardware_id: None,
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
    })
}

fn connect(
    config: connector::Config,
    server_name: String,
    port: u16,
    timeout_seconds: u64,
) -> Result<(ConnectionResult, UpgradedFramed)> {
    let server_addr = lookup_addr(&server_name, port).context("lookup addr")?;
    let connect_timeout = Duration::from_secs(timeout_seconds.clamp(3, 30));
    let read_timeout = Duration::from_secs(timeout_seconds.clamp(3, 8));

    let tcp_stream =
        TcpStream::connect_timeout(&server_addr, connect_timeout).context("TCP connect")?;
    tcp_stream
        .set_read_timeout(Some(read_timeout))
        .context("set read timeout")?;

    let client_addr = tcp_stream
        .local_addr()
        .context("get socket local address")?;
    let mut framed = ironrdp_blocking::Framed::new(tcp_stream);
    let mut connector = connector::ClientConnector::new(config, client_addr);

    let should_upgrade =
        ironrdp_blocking::connect_begin(&mut framed, &mut connector).context("begin connection")?;

    let initial_stream = framed.into_inner_no_leftover();
    let (upgraded_stream, server_public_key) =
        tls_upgrade(initial_stream, server_name.clone()).context("TLS upgrade")?;

    let upgraded = ironrdp_blocking::mark_as_upgraded(should_upgrade, &mut connector);
    let mut upgraded_framed = ironrdp_blocking::Framed::new(upgraded_stream);

    let mut network_client = ReqwestNetworkClient;
    let connection_result = ironrdp_blocking::connect_finalize(
        upgraded,
        connector,
        &mut upgraded_framed,
        &mut network_client,
        server_name.into(),
        server_public_key,
        None,
    )
    .context("finalize connection")?;

    Ok((connection_result, upgraded_framed))
}

fn active_stage(
    connection_result: ConnectionResult,
    mut framed: UpgradedFramed,
    image: &mut DecodedImage,
    input_actions: &[RdpInputAction],
) -> Result<()> {
    let mut active_stage = ActiveStage::new(connection_result);
    if !input_actions.is_empty() {
        process_input_actions(&mut framed, &mut active_stage, image, input_actions)
            .context("process input actions")?;
    }

    'outer: loop {
        let (action, payload) = match framed.read_pdu() {
            Ok((action, payload)) => (action, payload),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                break 'outer;
            }
            Err(error) => return Err(anyhow::Error::new(error).context("read frame")),
        };

        let outputs = active_stage
            .process(image, action, &payload)
            .context("active stage process")?;
        if process_active_stage_outputs(&mut framed, &mut active_stage, image, outputs)? {
            break 'outer;
        }
    }

    Ok(())
}

fn process_input_actions(
    framed: &mut UpgradedFramed,
    active_stage: &mut ActiveStage,
    image: &mut DecodedImage,
    input_actions: &[RdpInputAction],
) -> Result<()> {
    for action in input_actions {
        let events = action_to_fastpath_events(action);
        if events.is_empty() {
            continue;
        }
        let outputs = active_stage
            .process_fastpath_input(image, &events)
            .context("process fast-path input")?;
        if process_active_stage_outputs(framed, active_stage, image, outputs)? {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(12));
    }
    Ok(())
}

fn process_active_stage_outputs(
    framed: &mut UpgradedFramed,
    active_stage: &mut ActiveStage,
    image: &mut DecodedImage,
    outputs: Vec<ActiveStageOutput>,
) -> Result<bool> {
    for output in outputs {
        match output {
            ActiveStageOutput::ResponseFrame(frame) => {
                framed.write_all(&frame).context("write response")?;
            }
            ActiveStageOutput::Terminate(_) => return Ok(true),
            ActiveStageOutput::DeactivateAll(connection_activation) => {
                run_deactivation_reactivation(framed, active_stage, image, connection_activation)
                    .context("deactivation-reactivation")?;
            }
            _ => {}
        }
    }
    Ok(false)
}

fn action_to_fastpath_events(action: &RdpInputAction) -> Vec<FastPathInputEvent> {
    match action {
        RdpInputAction::MouseMove { x, y } => vec![FastPathInputEvent::MouseEvent(MousePdu {
            flags: PointerFlags::MOVE,
            number_of_wheel_rotation_units: 0,
            x_position: *x,
            y_position: *y,
        })],
        RdpInputAction::MouseClick {
            x,
            y,
            button,
            double_click,
        } => {
            let button_flag = match button {
                RdpMouseButton::Left => PointerFlags::LEFT_BUTTON,
                RdpMouseButton::Right => PointerFlags::RIGHT_BUTTON,
                RdpMouseButton::Middle => PointerFlags::MIDDLE_BUTTON_OR_WHEEL,
            };

            let mut events = vec![
                FastPathInputEvent::MouseEvent(MousePdu {
                    flags: PointerFlags::MOVE,
                    number_of_wheel_rotation_units: 0,
                    x_position: *x,
                    y_position: *y,
                }),
                FastPathInputEvent::MouseEvent(MousePdu {
                    flags: button_flag | PointerFlags::DOWN,
                    number_of_wheel_rotation_units: 0,
                    x_position: *x,
                    y_position: *y,
                }),
                FastPathInputEvent::MouseEvent(MousePdu {
                    flags: button_flag,
                    number_of_wheel_rotation_units: 0,
                    x_position: *x,
                    y_position: *y,
                }),
            ];

            if *double_click {
                events.extend([
                    FastPathInputEvent::MouseEvent(MousePdu {
                        flags: button_flag | PointerFlags::DOWN,
                        number_of_wheel_rotation_units: 0,
                        x_position: *x,
                        y_position: *y,
                    }),
                    FastPathInputEvent::MouseEvent(MousePdu {
                        flags: button_flag,
                        number_of_wheel_rotation_units: 0,
                        x_position: *x,
                        y_position: *y,
                    }),
                ]);
            }

            events
        }
        RdpInputAction::KeyPress {
            code,
            text,
            ctrl,
            alt,
            shift,
            meta,
        } => build_key_press_events(code, text.as_deref(), *ctrl, *alt, *shift, *meta),
    }
}

fn build_key_press_events(
    code: &str,
    text: Option<&str>,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
) -> Vec<FastPathInputEvent> {
    let mut events = Vec::new();
    let mut modifiers: Vec<(u8, bool)> = Vec::new();

    if ctrl {
        modifiers.push((0x1D, false));
    }
    if alt {
        modifiers.push((0x38, false));
    }
    if shift {
        modifiers.push((0x2A, false));
    }
    if meta {
        modifiers.push((0x5B, true));
    }

    for (scan_code, extended) in &modifiers {
        events.push(key_event(*scan_code, *extended, false));
    }

    if let Some((scan_code, extended)) = key_code_to_scan_code(code) {
        events.push(key_event(scan_code, extended, false));
        events.push(key_event(scan_code, extended, true));
    } else if let Some(value) = text.filter(|value| !value.is_empty()) {
        for code_unit in value.encode_utf16() {
            events.push(FastPathInputEvent::UnicodeKeyboardEvent(
                FastPathKeyboardFlags::empty(),
                code_unit,
            ));
            events.push(FastPathInputEvent::UnicodeKeyboardEvent(
                FastPathKeyboardFlags::RELEASE,
                code_unit,
            ));
        }
    }

    for (scan_code, extended) in modifiers.iter().rev() {
        events.push(key_event(*scan_code, *extended, true));
    }

    events
}

fn key_event(scan_code: u8, extended: bool, release: bool) -> FastPathInputEvent {
    let mut flags = FastPathKeyboardFlags::empty();
    if extended {
        flags |= FastPathKeyboardFlags::EXTENDED;
    }
    if release {
        flags |= FastPathKeyboardFlags::RELEASE;
    }
    FastPathInputEvent::KeyboardEvent(flags, scan_code)
}

fn key_code_to_scan_code(code: &str) -> Option<(u8, bool)> {
    match code {
        "KeyA" => Some((0x1E, false)),
        "KeyB" => Some((0x30, false)),
        "KeyC" => Some((0x2E, false)),
        "KeyD" => Some((0x20, false)),
        "KeyE" => Some((0x12, false)),
        "KeyF" => Some((0x21, false)),
        "KeyG" => Some((0x22, false)),
        "KeyH" => Some((0x23, false)),
        "KeyI" => Some((0x17, false)),
        "KeyJ" => Some((0x24, false)),
        "KeyK" => Some((0x25, false)),
        "KeyL" => Some((0x26, false)),
        "KeyM" => Some((0x32, false)),
        "KeyN" => Some((0x31, false)),
        "KeyO" => Some((0x18, false)),
        "KeyP" => Some((0x19, false)),
        "KeyQ" => Some((0x10, false)),
        "KeyR" => Some((0x13, false)),
        "KeyS" => Some((0x1F, false)),
        "KeyT" => Some((0x14, false)),
        "KeyU" => Some((0x16, false)),
        "KeyV" => Some((0x2F, false)),
        "KeyW" => Some((0x11, false)),
        "KeyX" => Some((0x2D, false)),
        "KeyY" => Some((0x15, false)),
        "KeyZ" => Some((0x2C, false)),
        "Digit0" => Some((0x0B, false)),
        "Digit1" => Some((0x02, false)),
        "Digit2" => Some((0x03, false)),
        "Digit3" => Some((0x04, false)),
        "Digit4" => Some((0x05, false)),
        "Digit5" => Some((0x06, false)),
        "Digit6" => Some((0x07, false)),
        "Digit7" => Some((0x08, false)),
        "Digit8" => Some((0x09, false)),
        "Digit9" => Some((0x0A, false)),
        "Minus" => Some((0x0C, false)),
        "Equal" => Some((0x0D, false)),
        "Backspace" => Some((0x0E, false)),
        "Tab" => Some((0x0F, false)),
        "BracketLeft" => Some((0x1A, false)),
        "BracketRight" => Some((0x1B, false)),
        "Enter" => Some((0x1C, false)),
        "ControlLeft" => Some((0x1D, false)),
        "ControlRight" => Some((0x1D, true)),
        "Semicolon" => Some((0x27, false)),
        "Quote" => Some((0x28, false)),
        "Backquote" => Some((0x29, false)),
        "ShiftLeft" => Some((0x2A, false)),
        "Backslash" => Some((0x2B, false)),
        "ShiftRight" => Some((0x36, false)),
        "AltLeft" => Some((0x38, false)),
        "AltRight" => Some((0x38, true)),
        "Space" => Some((0x39, false)),
        "CapsLock" => Some((0x3A, false)),
        "Escape" => Some((0x01, false)),
        "ArrowUp" => Some((0x48, true)),
        "ArrowDown" => Some((0x50, true)),
        "ArrowLeft" => Some((0x4B, true)),
        "ArrowRight" => Some((0x4D, true)),
        "Insert" => Some((0x52, true)),
        "Delete" => Some((0x53, true)),
        "Home" => Some((0x47, true)),
        "End" => Some((0x4F, true)),
        "PageUp" => Some((0x49, true)),
        "PageDown" => Some((0x51, true)),
        "MetaLeft" => Some((0x5B, true)),
        "MetaRight" => Some((0x5C, true)),
        _ => None,
    }
}

fn run_deactivation_reactivation(
    framed: &mut UpgradedFramed,
    active_stage: &mut ActiveStage,
    image: &mut DecodedImage,
    mut connection_activation: Box<ConnectionActivationSequence>,
) -> Result<()> {
    let mut buffer = WriteBuf::new();

    loop {
        single_connection_activation_step(framed, &mut connection_activation, &mut buffer)
            .context("reactivation step")?;

        let ConnectionActivationState::Finalized {
            io_channel_id,
            user_channel_id,
            desktop_size,
            enable_server_pointer,
            pointer_software_rendering,
        } = connection_activation.connection_activation_state()
        else {
            continue;
        };

        *image = DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
        active_stage.set_fastpath_processor(
            fast_path::ProcessorBuilder {
                io_channel_id,
                user_channel_id,
                enable_server_pointer,
                pointer_software_rendering,
            }
            .build(),
        );
        active_stage.set_enable_server_pointer(enable_server_pointer);
        break;
    }

    Ok(())
}

fn single_connection_activation_step(
    framed: &mut UpgradedFramed,
    sequence: &mut ConnectionActivationSequence,
    buffer: &mut WriteBuf,
) -> Result<()> {
    use ironrdp::connector::Sequence as _;

    buffer.clear();

    let written = if let Some(next_pdu_hint) = sequence.next_pdu_hint() {
        let pdu = framed
            .read_by_hint(next_pdu_hint)
            .context("read frame by hint")?;
        sequence.step(&pdu, buffer).context("sequence step")?
    } else {
        sequence
            .step_no_input(buffer)
            .context("sequence step without input")?
    };

    if let Some(response_len) = written.size() {
        let response = &buffer[..response_len];
        framed
            .write_all(response)
            .context("write sequence response")?;
    }

    Ok(())
}

fn lookup_addr(hostname: &str, port: u16) -> Result<SocketAddr> {
    let addr = (hostname, port)
        .to_socket_addrs()?
        .next()
        .context("socket address not found")?;
    Ok(addr)
}

fn tls_upgrade(
    stream: TcpStream,
    server_name: String,
) -> Result<(
    rustls::StreamOwned<rustls::ClientConnection, TcpStream>,
    Vec<u8>,
)> {
    let mut config = rustls::client::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(danger::NoCertificateVerification))
        .with_no_client_auth();

    config.key_log = std::sync::Arc::new(rustls::KeyLogFile::new());
    config.resumption = rustls::client::Resumption::disabled();
    let config = std::sync::Arc::new(config);

    let server_name = server_name.try_into()?;
    let client = rustls::ClientConnection::new(config, server_name)?;
    let mut tls_stream = rustls::StreamOwned::new(client, stream);
    tls_stream.flush()?;

    let cert = tls_stream
        .conn
        .peer_certificates()
        .and_then(|certificates| certificates.first())
        .context("peer certificate is missing")?;
    let server_public_key = extract_tls_server_public_key(cert)?;

    Ok((tls_stream, server_public_key))
}

fn extract_tls_server_public_key(cert: &[u8]) -> Result<Vec<u8>> {
    use x509_cert::der::Decode as _;

    let cert = x509_cert::Certificate::from_der(cert)?;
    let server_public_key = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .context("subject public key BIT STRING is not aligned")?
        .to_owned();

    Ok(server_public_key)
}

mod danger {
    use tokio_rustls::rustls::client::danger::{
        HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
    };
    use tokio_rustls::rustls::{pki_types, DigitallySignedStruct, Error, SignatureScheme};

    #[derive(Debug)]
    pub(super) struct NoCertificateVerification;

    impl ServerCertVerifier for NoCertificateVerification {
        fn verify_server_cert(
            &self,
            _: &pki_types::CertificateDer<'_>,
            _: &[pki_types::CertificateDer<'_>],
            _: &pki_types::ServerName<'_>,
            _: &[u8],
            _: pki_types::UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _: &[u8],
            _: &pki_types::CertificateDer<'_>,
            _: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _: &[u8],
            _: &pki_types::CertificateDer<'_>,
            _: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            vec![
                SignatureScheme::RSA_PKCS1_SHA1,
                SignatureScheme::ECDSA_SHA1_Legacy,
                SignatureScheme::RSA_PKCS1_SHA256,
                SignatureScheme::ECDSA_NISTP256_SHA256,
                SignatureScheme::RSA_PKCS1_SHA384,
                SignatureScheme::ECDSA_NISTP384_SHA384,
                SignatureScheme::RSA_PKCS1_SHA512,
                SignatureScheme::ECDSA_NISTP521_SHA512,
                SignatureScheme::RSA_PSS_SHA256,
                SignatureScheme::RSA_PSS_SHA384,
                SignatureScheme::RSA_PSS_SHA512,
                SignatureScheme::ED25519,
                SignatureScheme::ED448,
            ]
        }
    }
}
