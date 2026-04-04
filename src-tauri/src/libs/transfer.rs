#![allow(dead_code)]

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

pub const DEFAULT_INITIAL_CHUNK_SIZE: usize = 256 * 1024;
pub const DEFAULT_MIN_CHUNK_SIZE: usize = 64 * 1024;
pub const DEFAULT_MAX_CHUNK_SIZE: usize = 8 * 1024 * 1024;
pub const DEFAULT_EVALUATION_WINDOW: usize = 8;
pub const DEFAULT_INFLIGHT_LIMIT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJobConfig {
    pub initial_chunk_size: usize,
    pub min_chunk_size: usize,
    pub max_chunk_size: usize,
    pub evaluation_window: usize,
    pub inflight_limit_bytes: usize,
}

impl Default for TransferJobConfig {
    fn default() -> Self {
        Self {
            initial_chunk_size: DEFAULT_INITIAL_CHUNK_SIZE,
            min_chunk_size: DEFAULT_MIN_CHUNK_SIZE,
            max_chunk_size: DEFAULT_MAX_CHUNK_SIZE,
            evaluation_window: DEFAULT_EVALUATION_WINDOW,
            inflight_limit_bytes: DEFAULT_INFLIGHT_LIMIT_BYTES,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferMetrics {
    pub total_bytes: u64,
    pub total_chunks: u64,
    pub current_chunk_size: usize,
    pub average_throughput_bps: f64,
    pub last_rtt_ms: f64,
    pub peak_inflight_bytes: usize,
}

#[derive(Debug, Clone)]
struct WindowSample {
    bytes: usize,
    elapsed: Duration,
}

#[derive(Debug, Clone)]
pub struct AdaptiveChunkController {
    config: TransferJobConfig,
    chunk_size: usize,
    samples: Vec<WindowSample>,
    baseline_throughput: Option<f64>,
    baseline_rtt_ms: Option<f64>,
}

impl AdaptiveChunkController {
    pub fn new(config: TransferJobConfig) -> Self {
        let chunk_size = config
            .initial_chunk_size
            .clamp(config.min_chunk_size, config.max_chunk_size);
        Self {
            config,
            chunk_size,
            samples: Vec::new(),
            baseline_throughput: None,
            baseline_rtt_ms: None,
        }
    }

    pub fn chunk_size(&self) -> usize {
        self.chunk_size
    }

    pub fn on_success(&mut self, bytes: usize, elapsed: Duration) {
        self.samples.push(WindowSample { bytes, elapsed });
        if self.samples.len() < self.config.evaluation_window.max(1) {
            return;
        }

        let total_bytes: usize = self.samples.iter().map(|sample| sample.bytes).sum();
        let total_secs: f64 = self
            .samples
            .iter()
            .map(|sample| sample.elapsed.as_secs_f64())
            .sum::<f64>()
            .max(1e-6);
        let throughput = (total_bytes as f64) / total_secs;

        let avg_rtt_ms = self
            .samples
            .iter()
            .map(|sample| sample.elapsed.as_secs_f64() * 1000.0)
            .sum::<f64>()
            / self.samples.len() as f64;

        let baseline_throughput = self.baseline_throughput.unwrap_or(throughput);
        let baseline_rtt = self.baseline_rtt_ms.unwrap_or(avg_rtt_ms);

        let throughput_gain = if baseline_throughput <= 0.0 {
            0.0
        } else {
            (throughput - baseline_throughput) / baseline_throughput
        };
        let rtt_growth = if baseline_rtt <= 0.0 {
            0.0
        } else {
            (avg_rtt_ms - baseline_rtt) / baseline_rtt
        };

        // RTT + throughput heuristic:
        // - Increase chunk when throughput keeps improving and RTT is stable.
        // - Decrease chunk when RTT spikes or throughput regresses.
        if throughput_gain > 0.10 && rtt_growth < 0.15 {
            self.chunk_size = (self.chunk_size.saturating_mul(2))
                .min(self.config.max_chunk_size)
                .max(self.config.min_chunk_size);
            self.baseline_throughput = Some(throughput);
            self.baseline_rtt_ms = Some(avg_rtt_ms);
        } else if throughput_gain < -0.05 || rtt_growth > 0.25 {
            self.chunk_size = (self.chunk_size / 2)
                .max(self.config.min_chunk_size)
                .min(self.config.max_chunk_size);
            self.baseline_throughput = Some(throughput.max(1.0));
            self.baseline_rtt_ms = Some(avg_rtt_ms.max(1.0));
        } else {
            self.baseline_throughput = Some((baseline_throughput + throughput) / 2.0);
            self.baseline_rtt_ms = Some((baseline_rtt + avg_rtt_ms) / 2.0);
        }

        self.samples.clear();
    }

    pub fn on_error(&mut self) {
        self.chunk_size = (self.chunk_size / 2)
            .max(self.config.min_chunk_size)
            .min(self.config.max_chunk_size);
        self.samples.clear();
    }
}

pub fn transfer_reader_to_writer<R, W, F>(
    reader: &mut R,
    writer: &mut W,
    config: TransferJobConfig,
    mut on_chunk: F,
) -> Result<TransferMetrics>
where
    R: Read,
    W: Write,
    F: FnMut(u64, usize, Duration),
{
    let mut controller = AdaptiveChunkController::new(config);
    let mut metrics = TransferMetrics {
        current_chunk_size: controller.chunk_size(),
        ..TransferMetrics::default()
    };

    loop {
        let chunk_size = controller
            .chunk_size()
            .min(config.inflight_limit_bytes.max(config.min_chunk_size));
        let mut buffer = vec![0u8; chunk_size];
        let started_at = Instant::now();
        let read_size = reader
            .read(&mut buffer)
            .context("Falha ao ler chunk da origem de transferencia.")?;
        if read_size == 0 {
            break;
        }

        if let Err(error) = writer.write_all(&buffer[..read_size]) {
            controller.on_error();
            return Err(anyhow::anyhow!(
                "Falha ao gravar chunk no destino de transferencia: {}",
                error
            ));
        }

        let elapsed = started_at.elapsed();
        controller.on_success(read_size, elapsed);

        metrics.total_bytes = metrics.total_bytes.saturating_add(read_size as u64);
        metrics.total_chunks = metrics.total_chunks.saturating_add(1);
        metrics.current_chunk_size = controller.chunk_size();
        metrics.last_rtt_ms = elapsed.as_secs_f64() * 1000.0;
        metrics.peak_inflight_bytes = metrics.peak_inflight_bytes.max(chunk_size);
        let total_secs = elapsed.as_secs_f64().max(1e-6);
        metrics.average_throughput_bps = ((read_size as f64) / total_secs).max(1.0);

        on_chunk(metrics.total_bytes, metrics.current_chunk_size, elapsed);
    }

    writer
        .flush()
        .context("Falha ao finalizar flush do destino de transferencia.")?;

    Ok(metrics)
}
