use alpha::ping;

#[test]
fn ping_ok() {
    assert_eq!(ping(), "alpha");
}
