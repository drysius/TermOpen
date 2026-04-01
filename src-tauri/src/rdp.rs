use core::time::Duration;
use std::io::{Cursor, Write as _};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs as _};
use std::sync::Once;

use anyhow::{Context as _, Result};
use ironrdp::connector;
use ironrdp::connector::ConnectionResult;
use ironrdp::connector::Credentials;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
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
}

#[derive(Debug, Clone)]
pub struct RdpCaptureImage {
    pub png_bytes: Vec<u8>,
    pub width: u16,
    pub height: u16,
}

type UpgradedFramed = ironrdp_blocking::Framed<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>;
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

    active_stage(connection_result, framed, &mut image).context("active stage")?;

    let image_data = image.data().to_vec();
    let img: image::ImageBuffer<image::Rgba<u8>, _> =
        image::ImageBuffer::from_raw(u32::from(image.width()), u32::from(image.height()), image_data)
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
    let timeout = Duration::from_secs(timeout_seconds.clamp(3, 30));

    let tcp_stream = TcpStream::connect_timeout(&server_addr, timeout).context("TCP connect")?;
    tcp_stream
        .set_read_timeout(Some(timeout))
        .context("set read timeout")?;

    let client_addr = tcp_stream.local_addr().context("get socket local address")?;
    let mut framed = ironrdp_blocking::Framed::new(tcp_stream);
    let mut connector = connector::ClientConnector::new(config, client_addr);

    let should_upgrade = ironrdp_blocking::connect_begin(&mut framed, &mut connector)
        .context("begin connection")?;

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
) -> Result<()> {
    let mut active_stage = ActiveStage::new(connection_result);

    'outer: loop {
        let (action, payload) = match framed.read_pdu() {
            Ok((action, payload)) => (action, payload),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break 'outer,
            Err(error) => return Err(anyhow::Error::new(error).context("read frame")),
        };

        let outputs = active_stage.process(image, action, &payload)?;
        for output in outputs {
            match output {
                ActiveStageOutput::ResponseFrame(frame) => {
                    framed.write_all(&frame).context("write response")?;
                }
                ActiveStageOutput::Terminate(_) => break 'outer,
                _ => {}
            }
        }
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
) -> Result<(rustls::StreamOwned<rustls::ClientConnection, TcpStream>, Vec<u8>)> {
    let mut config = rustls::client::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(
            danger::NoCertificateVerification,
        ))
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
    use tokio_rustls::rustls::{DigitallySignedStruct, Error, SignatureScheme, pki_types};

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
