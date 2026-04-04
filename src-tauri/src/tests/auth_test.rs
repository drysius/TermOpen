use crate::libs::sync::request_sync_cancel;

#[test]
fn should_return_cancelled_sync_state() {
    let state = request_sync_cancel();
    assert_eq!(state.status, "idle");
    assert!(state.message.to_lowercase().contains("cancelad"));
}

