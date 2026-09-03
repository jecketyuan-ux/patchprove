use beta::foo;

#[test]
fn n_ok() {
    assert_eq!(foo::n(), 1);
}
