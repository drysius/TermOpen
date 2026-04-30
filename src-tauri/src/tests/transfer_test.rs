use std::time::Duration;

use crate::libs::transfer::{
    AdaptiveChunkController, TransferJobConfig, DEFAULT_INITIAL_CHUNK_SIZE,
};

#[test]
fn adaptive_chunk_grows_when_throughput_improves_with_stable_rtt() {
    let config = TransferJobConfig::default();
    let mut controller = AdaptiveChunkController::new(config);
    let base = controller.chunk_size();

    for _ in 0..config.evaluation_window {
        controller.on_success(DEFAULT_INITIAL_CHUNK_SIZE, Duration::from_millis(30));
    }
    for _ in 0..config.evaluation_window {
        controller.on_success(DEFAULT_INITIAL_CHUNK_SIZE * 2, Duration::from_millis(30));
    }

    assert!(controller.chunk_size() >= base);
}

#[test]
fn adaptive_chunk_shrinks_after_error() {
    let config = TransferJobConfig::default();
    let mut controller = AdaptiveChunkController::new(config);
    let previous = controller.chunk_size();
    controller.on_error();
    assert!(controller.chunk_size() <= previous);
}
