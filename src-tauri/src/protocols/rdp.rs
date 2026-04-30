use core::time::Duration;
use std::cmp::{max, min};
use std::collections::HashMap;
use std::io::Write as _;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs as _};
use std::sync::{mpsc, Arc, Once};
use std::thread::JoinHandle;
use std::time::Instant;

use anyhow::{Context as _, Result};
use ironrdp::connector;
use ironrdp::connector::connection_activation::{
    ConnectionActivationSequence, ConnectionActivationState,
};
use ironrdp::connector::ConnectionResult;
use ironrdp::connector::Credentials;
use ironrdp::core::WriteBuf;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::geometry::{InclusiveRectangle, Rectangle};
use ironrdp::pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags as FastPathKeyboardFlags};
use ironrdp::pdu::input::mouse::{MousePdu, PointerFlags};
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::session::fast_path;
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageOutput};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_graphics::pointer::DecodedPointer;
use ironrdp_pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use lz4_flex::frame::FrameEncoder;
use sspi::network_client::reqwest_network_client::ReqwestNetworkClient;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio_rustls::rustls;
use uuid::Uuid;

use crate::libs::models::BackendMessage;
use crate::utils::keyboard::{pressed_modifier_scan_codes, web_code_to_scan_code};
use crate::utils::mouse::{interpolate_pointer_route, WheelAccumulator};

#[derive(Debug, Clone)]
pub struct RdpSessionOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    pub width: u16,
    pub height: u16,
    pub timeout_seconds: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RdpSessionStartResult {
    Started { session_id: String },
    AuthRequired { message: BackendMessage },
    Error { message: BackendMessage },
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub enum RdpSessionControlEvent {
    Connecting {
        session_id: String,
        message: BackendMessage,
    },
    Ready {
        session_id: String,
        width: u16,
        height: u16,
    },
    AuthRequired {
        session_id: String,
        message: BackendMessage,
    },
    Error {
        session_id: String,
        message: BackendMessage,
    },
    Stopped {
        session_id: String,
    },
    ReleasedCapture {
        session_id: String,
        message: BackendMessage,
    },
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpViewportRect {
    pub x: i32,
    pub y: i32,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpSurfaceRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpSessionFocusInput {
    pub focused: bool,
    #[serde(default)]
    pub viewport_rect: Option<RdpViewportRect>,
    #[serde(default)]
    pub dpi_scale: Option<f64>,
    #[serde(default)]
    pub surface_rect: Option<RdpSurfaceRect>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RdpMouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct RdpPathPoint {
    pub x: u16,
    pub y: u16,
    #[serde(default, alias = "t")]
    pub t_ms: Option<u64>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RdpInputEvent {
    MouseMove {
        x: u16,
        y: u16,
        #[serde(default)]
        t_ms: Option<u64>,
    },
    MouseButtonDown {
        x: u16,
        y: u16,
        button: RdpMouseButton,
    },
    MouseButtonUp {
        x: u16,
        y: u16,
        button: RdpMouseButton,
    },
    MousePath {
        points: Vec<RdpPathPoint>,
    },
    MouseClick {
        x: u16,
        y: u16,
        button: RdpMouseButton,
        #[serde(default)]
        double_click: bool,
    },
    MouseScroll {
        x: u16,
        y: u16,
        #[serde(default)]
        delta_x: i16,
        #[serde(default)]
        delta_y: i16,
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

#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct RdpInputBatch {
    #[serde(default)]
    pub events: Vec<RdpInputEvent>,
}

#[derive(Debug)]
enum RdpSessionWorkerMessage {
    InputBatch(RdpInputBatch),
    Focus(RdpSessionFocusInput),
    Stop,
}

struct RdpSessionWorker {
    tx: mpsc::Sender<RdpSessionWorkerMessage>,
    _join: JoinHandle<()>,
}

#[derive(Default)]
pub struct RdpSessionManager {
    sessions: HashMap<String, RdpSessionWorker>,
}

impl RdpSessionManager {
    pub fn start(
        &mut self,
        options: RdpSessionOptions,
        control_channel: Channel<RdpSessionControlEvent>,
        video_rects_channel: Channel<InvokeResponseBody>,
        cursor_channel: Channel<InvokeResponseBody>,
        audio_channel: Channel<InvokeResponseBody>,
    ) -> RdpSessionStartResult {
        let session_id = Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel::<RdpSessionWorkerMessage>();
        let control_channel = Arc::new(control_channel);
        let video_rects_channel = Arc::new(video_rects_channel);
        let cursor_channel = Arc::new(cursor_channel);
        let audio_channel = Arc::new(audio_channel);
        let worker_session_id = session_id.clone();
        let worker_control_channel = control_channel.clone();
        let worker_video_rects_channel = video_rects_channel.clone();
        let worker_cursor_channel = cursor_channel.clone();
        let worker_audio_channel = audio_channel.clone();

        let join = std::thread::Builder::new()
            .name(format!("rdp-session-{}", &session_id[..8]))
            .spawn(move || {
                run_rdp_session_worker(
                    worker_session_id,
                    options,
                    worker_control_channel,
                    worker_video_rects_channel,
                    worker_cursor_channel,
                    worker_audio_channel,
                    rx,
                );
            });

        let Ok(join) = join else {
            return RdpSessionStartResult::Error {
                message: BackendMessage::key("rdp_worker_start_failed"),
            };
        };

        self.sessions
            .insert(session_id.clone(), RdpSessionWorker { tx, _join: join });

        RdpSessionStartResult::Started { session_id }
    }

    pub fn focus(&mut self, session_id: &str, focus: RdpSessionFocusInput) -> Result<()> {
        let Some(session) = self.sessions.get(session_id) else {
            anyhow::bail!("rdp_session_not_found");
        };

        if let Err(error) = session.tx.send(RdpSessionWorkerMessage::Focus(focus)) {
            self.sessions.remove(session_id);
            return Err(anyhow::Error::new(error).context("rdp focus send"));
        }

        Ok(())
    }

    pub fn input_batch(&mut self, session_id: &str, batch: RdpInputBatch) -> Result<()> {
        let Some(session) = self.sessions.get(session_id) else {
            anyhow::bail!("rdp_session_not_found");
        };

        if let Err(error) = session.tx.send(RdpSessionWorkerMessage::InputBatch(batch)) {
            self.sessions.remove(session_id);
            return Err(anyhow::Error::new(error).context("rdp input batch send"));
        }

        Ok(())
    }

    pub fn stop(&mut self, session_id: &str) -> Result<()> {
        let Some(session) = self.sessions.remove(session_id) else {
            anyhow::bail!("rdp_session_not_found");
        };

        let _ = session.tx.send(RdpSessionWorkerMessage::Stop);
        Ok(())
    }
}

type UpgradedFramed =
    ironrdp_blocking::Framed<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>;

static RUSTLS_PROVIDER_INIT: Once = Once::new();

const VIDEO_PACKET_MAGIC: [u8; 4] = *b"TRDV";
const CURSOR_PACKET_MAGIC: [u8; 4] = *b"TRDC";
const AUDIO_PACKET_MAGIC: [u8; 4] = *b"TRDA";
const PACKET_VERSION: u8 = 1;
const VIDEO_PACKET_HEADER_LEN: usize = 32;
const CURSOR_PACKET_HEADER_LEN: usize = 28;
const AUDIO_PACKET_HEADER_LEN: usize = 24;
const VIDEO_RECT_HEADER_LEN: usize = 20;
const VIDEO_FRAME_BEGIN: u8 = 0b0000_0001;
const VIDEO_FRAME_END: u8 = 0b0000_0010;
const COMPRESSION_NONE: u8 = 0;
const COMPRESSION_LZ4: u8 = 1;
const CURSOR_KIND_DEFAULT: u8 = 0;
const CURSOR_KIND_HIDDEN: u8 = 1;
const CURSOR_KIND_POSITION: u8 = 2;
const CURSOR_KIND_BITMAP: u8 = 3;
const MAX_DIRTY_RECTS_PER_FRAME: usize = 48;

fn ensure_rustls_crypto_provider() {
    RUSTLS_PROVIDER_INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn emit_control_event(
    channel: &Arc<Channel<RdpSessionControlEvent>>,
    event: RdpSessionControlEvent,
) -> bool {
    channel.send(event).is_ok()
}

fn emit_binary_packet(channel: &Arc<Channel<InvokeResponseBody>>, packet: Vec<u8>) -> bool {
    channel.send(InvokeResponseBody::Raw(packet)).is_ok()
}

#[derive(Debug, Default)]
struct SessionFocusState {
    focused: bool,
    viewport_rect: Option<RdpViewportRect>,
    surface_rect: Option<RdpSurfaceRect>,
    dpi_scale: f64,
    pending_resize: Option<(u16, u16)>,
}

impl SessionFocusState {
    fn new(width: u16, height: u16) -> Self {
        Self {
            focused: true,
            viewport_rect: Some(RdpViewportRect {
                x: 0,
                y: 0,
                width,
                height,
            }),
            surface_rect: None,
            dpi_scale: 1.0,
            pending_resize: None,
        }
    }

    fn apply(&mut self, update: RdpSessionFocusInput) {
        self.focused = update.focused;

        if let Some(scale) = update.dpi_scale.filter(|value| *value > 0.0) {
            self.dpi_scale = scale;
        }

        if let Some(viewport) = update.viewport_rect {
            let next_width = viewport.width.max(200);
            let next_height = viewport.height.max(200);
            let changed = self
                .viewport_rect
                .map(|current| current.width != next_width || current.height != next_height)
                .unwrap_or(true);

            self.viewport_rect = Some(RdpViewportRect {
                x: viewport.x,
                y: viewport.y,
                width: next_width,
                height: next_height,
            });
            if changed {
                self.pending_resize = Some((next_width, next_height));
            }
        }

        if let Some(surface) = update.surface_rect {
            self.surface_rect = Some(surface);
        }
    }

    fn take_pending_resize(&mut self) -> Option<(u16, u16)> {
        self.pending_resize.take()
    }
}

#[derive(Debug, Default)]
struct SessionDrain {
    terminated: bool,
    dirty_rects: Vec<InclusiveRectangle>,
    cursor_events: Vec<SessionCursorEvent>,
}

#[derive(Debug)]
enum SessionCursorEvent {
    Default,
    Hidden,
    Position { x: u16, y: u16 },
    Bitmap(Arc<DecodedPointer>),
}

fn run_rdp_session_worker(
    session_id: String,
    options: RdpSessionOptions,
    control_channel: Arc<Channel<RdpSessionControlEvent>>,
    video_rects_channel: Arc<Channel<InvokeResponseBody>>,
    cursor_channel: Arc<Channel<InvokeResponseBody>>,
    audio_channel: Arc<Channel<InvokeResponseBody>>,
    rx: mpsc::Receiver<RdpSessionWorkerMessage>,
) {
    if !emit_control_event(
        &control_channel,
        RdpSessionControlEvent::Connecting {
            session_id: session_id.clone(),
            message: BackendMessage::key("rdp_connecting"),
        },
    ) {
        return;
    }

    let worker_result = run_rdp_session_worker_inner(
        &session_id,
        options,
        &control_channel,
        &video_rects_channel,
        &cursor_channel,
        &audio_channel,
        rx,
    );

    if let Err(error) = worker_result {
        let reason = format!("{error:#}");
        let _ = if looks_like_auth_error(&reason) {
            emit_control_event(
                &control_channel,
                RdpSessionControlEvent::AuthRequired {
                    session_id: session_id.clone(),
                    message: BackendMessage::key("auth_required"),
                },
            )
        } else {
            let mut params = HashMap::new();
            params.insert("reason".to_string(), reason);
            emit_control_event(
                &control_channel,
                RdpSessionControlEvent::Error {
                    session_id: session_id.clone(),
                    message: BackendMessage::with_params("rdp_runtime_error", params),
                },
            )
        };
    }

    let _ = emit_control_event(
        &control_channel,
        RdpSessionControlEvent::Stopped {
            session_id: session_id.clone(),
        },
    );
}

fn run_rdp_session_worker_inner(
    session_id: &str,
    options: RdpSessionOptions,
    control_channel: &Arc<Channel<RdpSessionControlEvent>>,
    video_rects_channel: &Arc<Channel<InvokeResponseBody>>,
    cursor_channel: &Arc<Channel<InvokeResponseBody>>,
    _audio_channel: &Arc<Channel<InvokeResponseBody>>,
    rx: mpsc::Receiver<RdpSessionWorkerMessage>,
) -> Result<()> {
    ensure_rustls_crypto_provider();

    let config = build_config(
        options.username.clone(),
        options.password.clone(),
        options.domain.clone(),
        options.width,
        options.height,
    )?;

    let connect_timeout = Duration::from_secs(options.timeout_seconds.clamp(3, 30));
    let read_timeout = Duration::from_millis(80);
    let (connection_result, mut framed) = connect(
        config,
        options.host,
        options.port,
        connect_timeout,
        read_timeout,
    )
    .context("connect")?;

    let mut image = DecodedImage::new(
        PixelFormat::RgbA32,
        connection_result.desktop_size.width,
        connection_result.desktop_size.height,
    );
    let mut active_stage = ActiveStage::new(connection_result);
    let mut focus_state = SessionFocusState::new(image.width(), image.height());
    let mut frame_id: u64 = 0;
    let stream_started = Instant::now();
    let mut last_emit = Instant::now();
    let mut pending_dirty_rects = Vec::<InclusiveRectangle>::new();
    let mut pending_input = Vec::<RdpInputEvent>::new();
    let mut last_pointer_position: Option<(u16, u16)> = None;
    let mut last_cursor_position = (0u16, 0u16);
    let mut wheel_accumulator = WheelAccumulator::default();

    if !emit_control_event(
        control_channel,
        RdpSessionControlEvent::Ready {
            session_id: session_id.to_string(),
            width: image.width(),
            height: image.height(),
        },
    ) {
        return Ok(());
    }

    if let Some(initial_rect) = full_image_rect(&image) {
        pending_dirty_rects.push(initial_rect);
    }

    'worker: loop {
        while let Ok(message) = rx.try_recv() {
            match message {
                RdpSessionWorkerMessage::InputBatch(batch) => {
                    if !batch.events.is_empty() {
                        pending_input.extend(batch.events.into_iter().take(192));
                        if pending_input.len() > 512 {
                            let keep_from = pending_input.len().saturating_sub(512);
                            pending_input = pending_input.split_off(keep_from);
                        }
                    }
                }
                RdpSessionWorkerMessage::Focus(focus) => {
                    let was_focused = focus_state.focused;
                    focus_state.apply(focus);
                    if was_focused && !focus_state.focused {
                        let _ = emit_control_event(
                            control_channel,
                            RdpSessionControlEvent::ReleasedCapture {
                                session_id: session_id.to_string(),
                                message: BackendMessage::key("rdp_capture_released"),
                            },
                        );
                    }
                }
                RdpSessionWorkerMessage::Stop => break 'worker,
            }
        }

        if let Some((new_width, new_height)) = focus_state.take_pending_resize() {
            if let Some(resize) =
                active_stage.encode_resize(u32::from(new_width), u32::from(new_height), None, None)
            {
                let payload = resize.context("encode resize")?;
                framed
                    .write_all(payload.as_slice())
                    .context("write resize")?;
            }
        }

        if !pending_input.is_empty() {
            let batch = RdpInputBatch {
                events: std::mem::take(&mut pending_input),
            };
            let drain = process_input_batch(
                &mut framed,
                &mut active_stage,
                &mut image,
                &batch,
                &mut last_pointer_position,
                &mut last_cursor_position,
                &mut wheel_accumulator,
            )
            .context("process input batch")?;

            for cursor_event in drain.cursor_events {
                if !emit_cursor_event(cursor_channel, cursor_event, &mut last_cursor_position) {
                    break 'worker;
                }
            }
            for rect in drain.dirty_rects {
                queue_dirty_rect(&mut pending_dirty_rects, rect);
            }
            if drain.terminated {
                break 'worker;
            }
        }

        match active_stage_tick(&mut framed, &mut active_stage, &mut image)? {
            TickOutcome::Idle => {}
            TickOutcome::Updated(drain) => {
                for cursor_event in drain.cursor_events {
                    if !emit_cursor_event(cursor_channel, cursor_event, &mut last_cursor_position) {
                        break 'worker;
                    }
                }
                for rect in drain.dirty_rects {
                    queue_dirty_rect(&mut pending_dirty_rects, rect);
                }
                if drain.terminated {
                    break 'worker;
                }
            }
        }

        let emit_interval = if focus_state.focused {
            Duration::from_millis(16)
        } else {
            Duration::from_millis(110)
        };

        if pending_dirty_rects.is_empty() || last_emit.elapsed() < emit_interval {
            continue;
        }

        let rects = coalesce_rects(
            std::mem::take(&mut pending_dirty_rects),
            &image,
            MAX_DIRTY_RECTS_PER_FRAME,
        );
        if rects.is_empty() {
            continue;
        }

        let pts_us = stream_started
            .elapsed()
            .as_micros()
            .min(u128::from(u64::MAX)) as u64;
        let chunks = rects
            .iter()
            .map(|rect| build_video_rect_chunk(&image, rect))
            .collect::<Result<Vec<_>>>()?;

        let packet = build_video_rects_packet(
            frame_id,
            image.width(),
            image.height(),
            pts_us,
            &chunks,
            true,
            true,
        )?;
        if !emit_binary_packet(video_rects_channel, packet) {
            break 'worker;
        }

        frame_id = frame_id.wrapping_add(1);
        last_emit = Instant::now();
    }

    Ok(())
}

enum TickOutcome {
    Idle,
    Updated(SessionDrain),
}

fn active_stage_tick(
    framed: &mut UpgradedFramed,
    active_stage: &mut ActiveStage,
    image: &mut DecodedImage,
) -> Result<TickOutcome> {
    let (action, payload) = match framed.read_pdu() {
        Ok((action, payload)) => (action, payload),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            return Ok(TickOutcome::Idle);
        }
        Err(error) => return Err(anyhow::Error::new(error).context("read frame")),
    };

    let outputs = active_stage
        .process(image, action, &payload)
        .context("active stage process")?;
    let drain = process_active_stage_outputs(framed, active_stage, image, outputs)?;
    Ok(TickOutcome::Updated(drain))
}

fn process_input_batch(
    framed: &mut UpgradedFramed,
    active_stage: &mut ActiveStage,
    image: &mut DecodedImage,
    batch: &RdpInputBatch,
    last_pointer_position: &mut Option<(u16, u16)>,
    last_cursor_position: &mut (u16, u16),
    wheel_accumulator: &mut WheelAccumulator,
) -> Result<SessionDrain> {
    let mut aggregate = SessionDrain::default();

    for action in &batch.events {
        track_input_cursor_position(action, last_cursor_position);
        let events = expand_input_event(action, last_pointer_position, wheel_accumulator);
        if events.is_empty() {
            continue;
        }

        let outputs = active_stage
            .process_fastpath_input(image, &events)
            .context("process fast-path input")?;
        let drain = process_active_stage_outputs(framed, active_stage, image, outputs)?;
        aggregate.dirty_rects.extend(drain.dirty_rects);
        aggregate.cursor_events.extend(drain.cursor_events);
        if drain.terminated {
            aggregate.terminated = true;
            break;
        }
    }

    Ok(aggregate)
}

fn process_active_stage_outputs(
    framed: &mut UpgradedFramed,
    active_stage: &mut ActiveStage,
    image: &mut DecodedImage,
    outputs: Vec<ActiveStageOutput>,
) -> Result<SessionDrain> {
    let mut drain = SessionDrain::default();

    for output in outputs {
        match output {
            ActiveStageOutput::ResponseFrame(frame) => {
                framed.write_all(&frame).context("write response")?;
            }
            ActiveStageOutput::GraphicsUpdate(rect) => {
                drain.dirty_rects.push(rect);
            }
            ActiveStageOutput::PointerDefault => {
                drain.cursor_events.push(SessionCursorEvent::Default);
            }
            ActiveStageOutput::PointerHidden => {
                drain.cursor_events.push(SessionCursorEvent::Hidden);
            }
            ActiveStageOutput::PointerPosition { x, y } => {
                drain
                    .cursor_events
                    .push(SessionCursorEvent::Position { x, y });
            }
            ActiveStageOutput::PointerBitmap(pointer) => {
                drain
                    .cursor_events
                    .push(SessionCursorEvent::Bitmap(pointer));
            }
            ActiveStageOutput::Terminate(_) => {
                drain.terminated = true;
            }
            ActiveStageOutput::DeactivateAll(connection_activation) => {
                run_deactivation_reactivation(framed, active_stage, image, connection_activation)
                    .context("deactivation-reactivation")?;
                if let Some(full) = full_image_rect(image) {
                    drain.dirty_rects.push(full);
                }
            }
        }
    }

    Ok(drain)
}

fn emit_cursor_event(
    cursor_channel: &Arc<Channel<InvokeResponseBody>>,
    event: SessionCursorEvent,
    last_position: &mut (u16, u16),
) -> bool {
    let packet = match event {
        SessionCursorEvent::Default => {
            build_cursor_packet(CURSOR_KIND_DEFAULT, 0, 0, 0, 0, 0, 0, None)
        }
        SessionCursorEvent::Hidden => {
            build_cursor_packet(CURSOR_KIND_HIDDEN, 0, 0, 0, 0, 0, 0, None)
        }
        SessionCursorEvent::Position { x, y } => {
            *last_position = (x, y);
            build_cursor_packet(CURSOR_KIND_POSITION, x, y, 0, 0, 0, 0, None)
        }
        SessionCursorEvent::Bitmap(pointer) => build_cursor_packet(
            CURSOR_KIND_BITMAP,
            last_position.0,
            last_position.1,
            pointer.hotspot_x,
            pointer.hotspot_y,
            pointer.width,
            pointer.height,
            Some(pointer.bitmap_data.as_slice()),
        ),
    };

    match packet {
        Ok(bytes) => emit_binary_packet(cursor_channel, bytes),
        Err(_) => true,
    }
}

fn queue_dirty_rect(target: &mut Vec<InclusiveRectangle>, rect: InclusiveRectangle) {
    if rect.width() == 0 || rect.height() == 0 {
        return;
    }
    target.push(rect);
}

struct VideoRectChunk {
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    raw_size: u32,
    compression: u8,
    payload: Vec<u8>,
}

fn build_video_rect_chunk(
    image: &DecodedImage,
    rect: &InclusiveRectangle,
) -> Result<VideoRectChunk> {
    let raw = copy_rect_bgra(image, rect)?;
    let raw_size = u32::try_from(raw.len()).context("raw rect payload overflow")?;
    let (compression, payload) = compress_payload(&raw)?;

    Ok(VideoRectChunk {
        x: rect.left,
        y: rect.top,
        width: rect.width(),
        height: rect.height(),
        raw_size,
        compression,
        payload,
    })
}

fn compress_payload(raw: &[u8]) -> Result<(u8, Vec<u8>)> {
    let mut compressed = Vec::new();
    {
        let mut encoder = FrameEncoder::new(&mut compressed);
        encoder.write_all(raw).context("lz4 write")?;
        let _ = encoder.finish().context("lz4 finish")?;
    }

    if compressed.len() + 16 < raw.len() {
        Ok((COMPRESSION_LZ4, compressed))
    } else {
        Ok((COMPRESSION_NONE, raw.to_vec()))
    }
}

fn build_video_rects_packet(
    frame_id: u64,
    width: u16,
    height: u16,
    pts_us: u64,
    rects: &[VideoRectChunk],
    frame_begin: bool,
    frame_end: bool,
) -> Result<Vec<u8>> {
    let mut flags = 0u8;
    if frame_begin {
        flags |= VIDEO_FRAME_BEGIN;
    }
    if frame_end {
        flags |= VIDEO_FRAME_END;
    }

    let rect_count = u16::try_from(rects.len()).context("too many dirty rects")?;
    let total_payload_len = rects
        .iter()
        .map(|rect| VIDEO_RECT_HEADER_LEN + rect.payload.len())
        .sum::<usize>();

    let mut packet = Vec::with_capacity(VIDEO_PACKET_HEADER_LEN + total_payload_len);
    packet.extend_from_slice(&VIDEO_PACKET_MAGIC);
    packet.push(PACKET_VERSION);
    packet.push(flags);
    packet.extend_from_slice(&0u16.to_le_bytes());
    packet.extend_from_slice(&frame_id.to_le_bytes());
    packet.extend_from_slice(&width.to_le_bytes());
    packet.extend_from_slice(&height.to_le_bytes());
    packet.extend_from_slice(&rect_count.to_le_bytes());
    packet.extend_from_slice(&0u16.to_le_bytes());
    packet.extend_from_slice(&pts_us.to_le_bytes());

    for rect in rects {
        let payload_len = u32::try_from(rect.payload.len()).context("rect payload overflow")?;
        packet.extend_from_slice(&rect.x.to_le_bytes());
        packet.extend_from_slice(&rect.y.to_le_bytes());
        packet.extend_from_slice(&rect.width.to_le_bytes());
        packet.extend_from_slice(&rect.height.to_le_bytes());
        packet.push(rect.compression);
        packet.extend_from_slice(&[0u8; 3]);
        packet.extend_from_slice(&rect.raw_size.to_le_bytes());
        packet.extend_from_slice(&payload_len.to_le_bytes());
        packet.extend_from_slice(rect.payload.as_slice());
    }

    Ok(packet)
}

fn build_cursor_packet(
    kind: u8,
    x: u16,
    y: u16,
    hotspot_x: u16,
    hotspot_y: u16,
    width: u16,
    height: u16,
    payload: Option<&[u8]>,
) -> Result<Vec<u8>> {
    let (compression, bytes) = if let Some(data) = payload {
        compress_payload(data)?
    } else {
        (COMPRESSION_NONE, Vec::new())
    };

    let payload_len = u32::try_from(bytes.len()).context("cursor payload overflow")?;

    let mut packet = Vec::with_capacity(CURSOR_PACKET_HEADER_LEN + bytes.len());
    packet.extend_from_slice(&CURSOR_PACKET_MAGIC);
    packet.push(PACKET_VERSION);
    packet.push(kind);
    packet.extend_from_slice(&0u16.to_le_bytes());
    packet.extend_from_slice(&x.to_le_bytes());
    packet.extend_from_slice(&y.to_le_bytes());
    packet.extend_from_slice(&hotspot_x.to_le_bytes());
    packet.extend_from_slice(&hotspot_y.to_le_bytes());
    packet.extend_from_slice(&width.to_le_bytes());
    packet.extend_from_slice(&height.to_le_bytes());
    packet.extend_from_slice(&payload_len.to_le_bytes());
    packet.push(compression);
    packet.extend_from_slice(&[0u8; 3]);
    packet.extend_from_slice(bytes.as_slice());

    Ok(packet)
}

#[allow(dead_code)]
fn build_audio_pcm_packet(
    pts_us: u64,
    sample_rate: u32,
    channels: u8,
    bits_per_sample: u8,
    payload: &[u8],
) -> Result<Vec<u8>> {
    let payload_len = u32::try_from(payload.len()).context("audio payload overflow")?;

    let mut packet = Vec::with_capacity(AUDIO_PACKET_HEADER_LEN + payload.len());
    packet.extend_from_slice(&AUDIO_PACKET_MAGIC);
    packet.push(PACKET_VERSION);
    packet.push(COMPRESSION_NONE);
    packet.push(channels);
    packet.push(bits_per_sample);
    packet.extend_from_slice(&sample_rate.to_le_bytes());
    packet.extend_from_slice(&pts_us.to_le_bytes());
    packet.extend_from_slice(&payload_len.to_le_bytes());
    packet.extend_from_slice(payload);

    Ok(packet)
}

fn copy_rect_bgra(image: &DecodedImage, rect: &InclusiveRectangle) -> Result<Vec<u8>> {
    let rect = normalize_rect(rect, image).context("dirty rect out of bounds")?;
    let bytes_per_pixel = 4usize;
    let stride = image.stride();
    let width = usize::from(rect.width());
    let height = usize::from(rect.height());
    let left = usize::from(rect.left);
    let top = usize::from(rect.top);
    let row_bytes = width * bytes_per_pixel;
    let mut output = vec![0u8; row_bytes * height];
    let data = image.data();

    for row in 0..height {
        let src_start = (top + row) * stride + left * bytes_per_pixel;
        let src_end = src_start + row_bytes;
        let dst_start = row * row_bytes;
        let dst_end = dst_start + row_bytes;
        output[dst_start..dst_end].copy_from_slice(&data[src_start..src_end]);
    }

    // ironrdp image is RGBA32 here; compositor contract uses BGRA8.
    for pixel in output.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }

    Ok(output)
}

fn normalize_rect(rect: &InclusiveRectangle, image: &DecodedImage) -> Option<InclusiveRectangle> {
    if image.width() == 0 || image.height() == 0 {
        return None;
    }

    let max_x = image.width() - 1;
    let max_y = image.height() - 1;
    let left = min(rect.left, max_x);
    let top = min(rect.top, max_y);
    let right = min(rect.right, max_x);
    let bottom = min(rect.bottom, max_y);

    if right < left || bottom < top {
        return None;
    }

    Some(InclusiveRectangle {
        left,
        top,
        right,
        bottom,
    })
}

fn full_image_rect(image: &DecodedImage) -> Option<InclusiveRectangle> {
    if image.width() == 0 || image.height() == 0 {
        return None;
    }

    Some(InclusiveRectangle {
        left: 0,
        top: 0,
        right: image.width() - 1,
        bottom: image.height() - 1,
    })
}

fn coalesce_rects(
    rects: Vec<InclusiveRectangle>,
    image: &DecodedImage,
    max_rects: usize,
) -> Vec<InclusiveRectangle> {
    let mut normalized = rects
        .into_iter()
        .filter_map(|rect| normalize_rect(&rect, image))
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        return Vec::new();
    }

    let mut merged: Vec<InclusiveRectangle> = Vec::new();
    for rect in normalized.drain(..) {
        let mut current = rect;
        let mut idx = 0usize;
        while idx < merged.len() {
            if rects_touch_or_overlap(&current, &merged[idx]) {
                current = merge_rects(&current, &merged[idx]);
                merged.swap_remove(idx);
                idx = 0;
                continue;
            }
            idx += 1;
        }
        merged.push(current);
    }

    if merged.len() <= max_rects {
        return merged;
    }

    let mut bounds = merged[0].clone();
    for rect in merged.iter().skip(1) {
        bounds = merge_rects(&bounds, rect);
    }
    vec![bounds]
}

fn rects_touch_or_overlap(a: &InclusiveRectangle, b: &InclusiveRectangle) -> bool {
    let a_left = i32::from(a.left);
    let a_top = i32::from(a.top);
    let a_right = i32::from(a.right);
    let a_bottom = i32::from(a.bottom);
    let b_left = i32::from(b.left);
    let b_top = i32::from(b.top);
    let b_right = i32::from(b.right);
    let b_bottom = i32::from(b.bottom);

    !(a_right + 1 < b_left || b_right + 1 < a_left || a_bottom + 1 < b_top || b_bottom + 1 < a_top)
}

fn merge_rects(a: &InclusiveRectangle, b: &InclusiveRectangle) -> InclusiveRectangle {
    InclusiveRectangle {
        left: min(a.left, b.left),
        top: min(a.top, b.top),
        right: max(a.right, b.right),
        bottom: max(a.bottom, b.bottom),
    }
}

fn track_input_cursor_position(action: &RdpInputEvent, last_cursor_position: &mut (u16, u16)) {
    match action {
        RdpInputEvent::MouseMove { x, y, .. }
        | RdpInputEvent::MouseButtonDown { x, y, .. }
        | RdpInputEvent::MouseButtonUp { x, y, .. }
        | RdpInputEvent::MouseClick { x, y, .. }
        | RdpInputEvent::MouseScroll { x, y, .. } => {
            *last_cursor_position = (*x, *y);
        }
        RdpInputEvent::MousePath { points } => {
            if let Some(last) = points.last() {
                *last_cursor_position = (last.x, last.y);
            }
        }
        RdpInputEvent::KeyPress { .. } => {}
    }
}

fn expand_input_event(
    action: &RdpInputEvent,
    last_pointer_position: &mut Option<(u16, u16)>,
    wheel_accumulator: &mut WheelAccumulator,
) -> Vec<FastPathInputEvent> {
    match action {
        RdpInputEvent::MouseMove { x, y, t_ms } => {
            let _ = t_ms;
            let mut events = Vec::new();
            if let Some((from_x, from_y)) = *last_pointer_position {
                for (next_x, next_y) in interpolate_pointer_route(from_x, from_y, *x, *y) {
                    events.extend(action_to_fastpath_events(&RdpInputEvent::MouseMove {
                        x: next_x,
                        y: next_y,
                        t_ms: None,
                    }));
                }
            } else {
                events.extend(action_to_fastpath_events(action));
            }
            *last_pointer_position = Some((*x, *y));
            events
        }
        RdpInputEvent::MousePath { points } => {
            if points.is_empty() {
                return Vec::new();
            }

            let mut events = Vec::new();
            let mut from = *last_pointer_position;
            for point in points {
                let (to_x, to_y) = (point.x, point.y);
                if let Some((from_x, from_y)) = from {
                    for (next_x, next_y) in interpolate_pointer_route(from_x, from_y, to_x, to_y) {
                        events.extend(action_to_fastpath_events(&RdpInputEvent::MouseMove {
                            x: next_x,
                            y: next_y,
                            t_ms: point.t_ms,
                        }));
                    }
                } else {
                    events.extend(action_to_fastpath_events(&RdpInputEvent::MouseMove {
                        x: to_x,
                        y: to_y,
                        t_ms: point.t_ms,
                    }));
                }
                from = Some((to_x, to_y));
            }
            *last_pointer_position = from;
            events
        }
        RdpInputEvent::MouseButtonDown { x, y, .. }
        | RdpInputEvent::MouseButtonUp { x, y, .. }
        | RdpInputEvent::MouseClick { x, y, .. } => {
            *last_pointer_position = Some((*x, *y));
            action_to_fastpath_events(action)
        }
        RdpInputEvent::MouseScroll {
            x,
            y,
            delta_x,
            delta_y,
        } => {
            *last_pointer_position = Some((*x, *y));
            let (horizontal_steps, vertical_steps) = wheel_accumulator.push(*delta_x, *delta_y);
            build_wheel_fastpath_events(*x, *y, &horizontal_steps, &vertical_steps)
        }
        RdpInputEvent::KeyPress { .. } => action_to_fastpath_events(action),
    }
}

fn action_to_fastpath_events(action: &RdpInputEvent) -> Vec<FastPathInputEvent> {
    match action {
        RdpInputEvent::MouseMove { x, y, .. } => vec![FastPathInputEvent::MouseEvent(MousePdu {
            flags: PointerFlags::MOVE,
            number_of_wheel_rotation_units: 0,
            x_position: *x,
            y_position: *y,
        })],
        RdpInputEvent::MouseButtonDown { x, y, button } => {
            let button_flag = button_to_pointer_flag(button);
            vec![
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
            ]
        }
        RdpInputEvent::MouseButtonUp { x, y, button } => {
            let button_flag = button_to_pointer_flag(button);
            vec![
                FastPathInputEvent::MouseEvent(MousePdu {
                    flags: PointerFlags::MOVE,
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
            ]
        }
        RdpInputEvent::MouseClick {
            x,
            y,
            button,
            double_click,
        } => {
            let button_flag = button_to_pointer_flag(button);

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
        RdpInputEvent::MouseScroll {
            x,
            y,
            delta_x,
            delta_y,
        } => build_wheel_fastpath_events(*x, *y, &[*delta_x], &[*delta_y]),
        RdpInputEvent::MousePath { .. } => Vec::new(),
        RdpInputEvent::KeyPress {
            code,
            text,
            ctrl,
            alt,
            shift,
            meta,
        } => build_key_press_events(code, text.as_deref(), *ctrl, *alt, *shift, *meta),
    }
}

fn build_wheel_fastpath_events(
    x: u16,
    y: u16,
    horizontal_steps: &[i16],
    vertical_steps: &[i16],
) -> Vec<FastPathInputEvent> {
    if horizontal_steps.is_empty() && vertical_steps.is_empty() {
        return Vec::new();
    }

    let mut events = vec![FastPathInputEvent::MouseEvent(MousePdu {
        flags: PointerFlags::MOVE,
        number_of_wheel_rotation_units: 0,
        x_position: x,
        y_position: y,
    })];

    for delta in vertical_steps {
        events.push(FastPathInputEvent::MouseEvent(MousePdu {
            flags: PointerFlags::MIDDLE_BUTTON_OR_WHEEL | PointerFlags::VERTICAL_WHEEL,
            number_of_wheel_rotation_units: (*delta).clamp(-255, 255),
            x_position: x,
            y_position: y,
        }));
    }

    for delta in horizontal_steps {
        events.push(FastPathInputEvent::MouseEvent(MousePdu {
            flags: PointerFlags::MIDDLE_BUTTON_OR_WHEEL | PointerFlags::HORIZONTAL_WHEEL,
            number_of_wheel_rotation_units: (*delta).clamp(-255, 255),
            x_position: x,
            y_position: y,
        }));
    }

    events
}

fn button_to_pointer_flag(button: &RdpMouseButton) -> PointerFlags {
    match button {
        RdpMouseButton::Left => PointerFlags::LEFT_BUTTON,
        RdpMouseButton::Right => PointerFlags::RIGHT_BUTTON,
        RdpMouseButton::Middle => PointerFlags::MIDDLE_BUTTON_OR_WHEEL,
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
    let modifiers = pressed_modifier_scan_codes(ctrl, alt, shift, meta);

    for modifier in &modifiers {
        events.push(key_event(modifier.code, modifier.extended, false));
    }

    if let Some(scan_code) = web_code_to_scan_code(code) {
        events.push(key_event(scan_code.code, scan_code.extended, false));
        events.push(key_event(scan_code.code, scan_code.extended, true));
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

    for modifier in modifiers.iter().rev() {
        events.push(key_event(modifier.code, modifier.extended, true));
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

fn looks_like_auth_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("logon")
        || lower.contains("authentication")
        || lower.contains("credssp")
        || lower.contains("sec_e_logon_denied")
        || lower.contains("status_logon_failure")
        || lower.contains("nla")
        || lower.contains("access denied")
        || lower.contains("password")
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
        client_name: "openptl-rdp".to_owned(),
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
        enable_server_pointer: true,
        request_data: None,
        autologon: false,
        enable_audio_playback: true,
        pointer_software_rendering: false,
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
    connect_timeout: Duration,
    read_timeout: Duration,
) -> Result<(ConnectionResult, UpgradedFramed)> {
    let server_addr = lookup_addr(&server_name, port).context("lookup addr")?;

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

#[cfg(test)]
mod tests {
    use super::*;

    fn read_u16(bytes: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
    }

    fn read_u32(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    }

    fn read_u64(bytes: &[u8], offset: usize) -> u64 {
        u64::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ])
    }

    #[test]
    fn should_encode_video_packet_with_frame_commit() {
        let rect = VideoRectChunk {
            x: 4,
            y: 6,
            width: 12,
            height: 10,
            raw_size: 480,
            compression: COMPRESSION_NONE,
            payload: vec![7u8; 480],
        };

        let packet = build_video_rects_packet(42, 1280, 720, 90_000, &[rect], true, true)
            .expect("video packet should encode");

        assert_eq!(&packet[0..4], VIDEO_PACKET_MAGIC);
        assert_eq!(packet[4], PACKET_VERSION);
        assert_eq!(packet[5] & VIDEO_FRAME_BEGIN, VIDEO_FRAME_BEGIN);
        assert_eq!(packet[5] & VIDEO_FRAME_END, VIDEO_FRAME_END);
        assert_eq!(read_u64(&packet, 8), 42);
        assert_eq!(read_u16(&packet, 16), 1280);
        assert_eq!(read_u16(&packet, 18), 720);
        assert_eq!(read_u16(&packet, 20), 1);
        assert_eq!(read_u64(&packet, 24), 90_000);

        let rect_offset = VIDEO_PACKET_HEADER_LEN;
        assert_eq!(read_u16(&packet, rect_offset), 4);
        assert_eq!(read_u16(&packet, rect_offset + 2), 6);
        assert_eq!(read_u16(&packet, rect_offset + 4), 12);
        assert_eq!(read_u16(&packet, rect_offset + 6), 10);
        assert_eq!(packet[rect_offset + 8], COMPRESSION_NONE);
        assert_eq!(read_u32(&packet, rect_offset + 12), 480);
        assert_eq!(read_u32(&packet, rect_offset + 16), 480);
    }

    #[test]
    fn should_encode_cursor_bitmap_payload() {
        let bitmap = vec![0xAAu8; 4 * 8 * 8];
        let packet = build_cursor_packet(
            CURSOR_KIND_BITMAP,
            0,
            0,
            2,
            3,
            8,
            8,
            Some(bitmap.as_slice()),
        )
        .expect("cursor packet should encode");

        assert_eq!(&packet[0..4], CURSOR_PACKET_MAGIC);
        assert_eq!(packet[4], PACKET_VERSION);
        assert_eq!(packet[5], CURSOR_KIND_BITMAP);
        assert_eq!(read_u16(&packet, 12), 2);
        assert_eq!(read_u16(&packet, 14), 3);
        assert_eq!(read_u16(&packet, 16), 8);
        assert_eq!(read_u16(&packet, 18), 8);

        let payload_len = read_u32(&packet, 20) as usize;
        assert_eq!(packet.len(), CURSOR_PACKET_HEADER_LEN + payload_len);
        assert!(payload_len > 0);
    }

    #[test]
    fn should_keep_interpolated_route_continuous() {
        let points = interpolate_pointer_route(0, 0, 400, 0);
        assert!(points.len() > 2);
        assert_eq!(points.last().copied(), Some((400, 0)));
        assert!(points.windows(2).all(|pair| pair[1].0 >= pair[0].0));
    }
}
