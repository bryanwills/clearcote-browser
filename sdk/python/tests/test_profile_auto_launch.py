"""The launch-path wiring for ``profile="auto"``.

Covers the decisions _apply_auto_profile makes BEFORE any browser starts, by stubbing the two
expensive collaborators (measure_host launches a browser; resolve_auto hits the network).
"""

import clearcote
import pytest

HOST = {
    "os_family": "windows", "browser_major": 150, "gpu_vendor": "intel",
    "screen_width": 3440, "screen_height": 1440, "device_pixel_ratio": 1,
    "hardware_concurrency": 16, "device_memory": 16,
}

SERVICE_PROFILE = {"navigator": {"user_agent": "ua"}, "screen": {"width": 1920}}


@pytest.fixture
def stubbed(monkeypatch):
    calls = {"measure": 0, "resolve": 0, "select": None}

    def fake_measure(launch_fn, exe, major):
        calls["measure"] += 1
        calls["major"] = major
        return HOST

    def fake_resolve(host, **kw):
        calls["resolve"] += 1
        calls["select"] = kw
        return {"profile": SERVICE_PROFILE, "selection": {"entry": {"id": "svc-1"}}, "source": "service"}

    monkeypatch.setattr(clearcote, "measure_host", fake_measure)
    monkeypatch.setattr(clearcote, "resolve_auto", fake_resolve)
    return calls


class TestApplyAutoProfile:
    def test_sets_fingerprint_profile_from_the_resolver(self, stubbed):
        fp = {}
        clearcote._apply_auto_profile(fp, "/path/chrome", {}, quiet=True)
        assert fp["fingerprint_profile"] == SERVICE_PROFILE
        assert stubbed["resolve"] == 1

    def test_never_sets_a_seed(self, stubbed):
        # The seed is what engages farbling; "auto" exists to avoid it.
        fp = {}
        clearcote._apply_auto_profile(fp, "/path/chrome", {}, quiet=True)
        assert "fingerprint" not in fp

    def test_explicit_profile_wins_and_skips_all_work(self, stubbed):
        # If the caller already named a profile there is nothing to decide, and we must not pay
        # for a browser launch or a network call to decide it anyway.
        fp = {"fingerprint_profile": {"navigator": {"user_agent": "mine"}}}
        clearcote._apply_auto_profile(fp, "/path/chrome", {}, quiet=True)
        assert fp["fingerprint_profile"]["navigator"]["user_agent"] == "mine"
        assert stubbed["measure"] == 0
        assert stubbed["resolve"] == 0

    def test_passes_the_engine_major_to_host_measurement(self, stubbed):
        # A profile captured on another major contradicts the engine, so the major that gets
        # filtered on must be the one the binary actually is.
        fp = {}
        clearcote._apply_auto_profile(fp, "/path/chrome", {}, quiet=True)
        assert stubbed["major"] == int(str(clearcote.RELEASE["version"]).split(".")[0])

    def test_forwards_selection_options(self, stubbed):
        fp = {}
        clearcote._apply_auto_profile(fp, "/path/chrome", {"key": "acct-9", "mode": "best"}, quiet=True)
        assert stubbed["select"]["key"] == "acct-9"
        assert stubbed["select"]["mode"] == "best"

    def test_warns_when_a_seed_is_also_set(self, stubbed, capsys):
        # Silently ignoring the seed, or silently keeping it, would both be worse than saying so.
        fp = {"fingerprint": "seed-1"}
        clearcote._apply_auto_profile(fp, "/path/chrome", {}, quiet=False)
        err = capsys.readouterr().err
        assert "fingerprint seed" in err
        assert "farbling" in err

    def test_quiet_suppresses_the_warning(self, stubbed, capsys):
        fp = {"fingerprint": "seed-1"}
        clearcote._apply_auto_profile(fp, "/path/chrome", {}, quiet=True)
        assert capsys.readouterr().err == ""

    def test_license_is_forwarded_from_the_pro_tuple(self, stubbed):
        fp = {}
        clearcote._apply_auto_profile(fp, "/path/chrome", {}, quiet=True,
                                      pro=("cc_lic_x", "https://api.example"))
        assert stubbed["select"]["license_key"] == "cc_lic_x"
        assert stubbed["select"]["api_base"] == "https://api.example"


class TestPrepareRouting:
    def test_auto_is_not_treated_as_a_saved_profile_name(self, monkeypatch):
        # resolve_profile_options would raise or look up a file called "auto"; the auto path must
        # never reach it.
        def boom(*a, **k):
            raise AssertionError("resolve_profile_options must not be called for profile='auto'")

        monkeypatch.setattr(clearcote, "resolve_profile_options", boom)
        kwargs = {"profile": "auto"}
        # _prepare does much more than this, but the routing decision happens first and is what
        # this asserts; it raises later for lack of a real binary, which is fine.
        try:
            clearcote._prepare(kwargs)
        except AssertionError:
            raise
        except Exception:
            pass  # any non-AssertionError failure is downstream of the routing decision
