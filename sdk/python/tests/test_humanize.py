from clearcote._humanize import CURSOR_OVERLAY, install_humanize


def _fake_browser():
    b = type("FakeBrowser", (), {})()
    b.new_page = lambda **kw: object()
    b.new_context = lambda **kw: object()
    return b


def test_install_is_noop_when_off():
    b = _fake_browser()
    np, nc = b.new_page, b.new_context
    install_humanize(b, humanize=False, show_cursor=False)
    assert b.new_page is np and b.new_context is nc


def test_install_wraps_when_humanize_on():
    b = _fake_browser()
    np = b.new_page
    install_humanize(b, humanize=True)
    assert b.new_page is not np


def test_install_wraps_when_show_cursor_on():
    b = _fake_browser()
    nc = b.new_context
    install_humanize(b, show_cursor=True)
    assert b.new_context is not nc


def test_cursor_overlay_is_idempotent_iife():
    # runs as both an add_init_script source and via page.evaluate, so it must be a self-calling
    # IIFE guarded against double-injection.
    assert "__clearcoteCursor" in CURSOR_OVERLAY
    body = CURSOR_OVERLAY.strip()
    assert body.startswith("(()") and body.endswith(")();")


class _SyncKeyboard:
    def __init__(self):
        self.events = []

    def press(self, key, **kw):
        self.events.append(("press", key))

    def type(self, text, **kw):
        self.events.append(("type", text))

    def down(self, key):
        self.events.append(("down", key))

    def up(self, key):
        self.events.append(("up", key))


class _SyncPage:
    """Just enough of a sync Page for attach_humanize to wire up; every other method is a no-op."""

    def __init__(self):
        self.keyboard = _SyncKeyboard()
        self.main_frame = object()

    def __getattr__(self, name):
        if name == "mouse":
            m = type("Mouse", (), {})()
            for n in ("move", "click", "wheel", "down", "up", "dblclick"):
                setattr(m, n, lambda *a, **k: None)
            self.__dict__["mouse"] = m
            return m
        return lambda *a, **k: None


def test_sync_typing_holds_shift_for_capitals_and_symbols():
    from clearcote._humanize import attach_humanize
    page = _SyncPage()
    attach_humanize(None, page, humanize=True)
    page.keyboard.type("Hi!")
    ev = [e for e in page.keyboard.events if e[1] in ("Shift", "H", "i", "!")]
    assert ev == [
        ("down", "Shift"), ("press", "H"), ("up", "Shift"),
        ("press", "i"),
        ("down", "Shift"), ("press", "!"), ("up", "Shift"),
    ]


def test_needs_shift_is_the_us_layout():
    from clearcote._humanize import _needs_shift
    assert all(_needs_shift(c) for c in 'AZ~!@#$%^&*()_+{}|:"<>?')
    assert not any(_needs_shift(c) for c in "az09`-=[];',./ \t\\\u00f6")
