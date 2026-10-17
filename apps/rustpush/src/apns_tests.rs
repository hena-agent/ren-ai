use rustpush::APSMessage;

#[test]
fn certification_only_accepts_its_own_acknowledgement() {
    let ack = |id, status| APSMessage::Ack {
        token: None,
        for_id: id,
        status,
    };
    assert_eq!(ack(42, 0).ack_for(43), None);
    assert_eq!(ack(42, 7).ack_for(43), None);
    assert_eq!(ack(42, 0).ack_for(42), Some(0));
    assert_eq!(ack(42, 7).ack_for(42), Some(7));
    assert_eq!(APSMessage::Pong.ack_for(42), None);
}
