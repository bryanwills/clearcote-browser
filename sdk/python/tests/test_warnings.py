from clearcote._warnings import coherence_warnings


def codes(opts, host="win32", build="149"):
    return {w["code"] for w in coherence_warnings(opts, host_platform=host, build_major=build)}


def test_coherent_default_is_silent():
    assert coherence_warnings(
        {"platform": "windows", "fingerprint": "s", "headless": False},
        host_platform="win32", build_major="149") == []


def test_proxy_without_geo():
    assert "proxy-no-geo" in codes({"proxy": {"server": "http://h:8080"}, "headless": False})
    # silent when geoip is on or manual geo is supplied
    assert "proxy-no-geo" not in codes({"proxy": {"server": "http://h:8080"}, "geoip": True, "headless": False})
    assert "proxy-no-geo" not in codes(
        {"proxy": "http://h:8080", "timezone": "America/New_York", "accept_language": "en-US,en", "headless": False})


def test_socks_geoip_cannot_resolve():
    assert "socks-geoip" in codes({"proxy": "socks5://u:p@h:1", "geoip": True, "headless": False})
    assert "socks-geoip" not in codes({"proxy": "http://h:1", "geoip": True, "headless": False})


def test_platform_vs_host_fonts():
    assert "platform-host-fonts" in codes({"platform": "macos", "headless": False})
    assert "platform-host-fonts" not in codes({"platform": "windows", "headless": False})
    assert "platform-host-fonts" not in codes(
        {"platform": "macos", "fingerprint_profile": "p.json", "headless": False})


def test_gpu_incoherent_with_platform():
    assert "gpu-platform" in codes(
        {"platform": "macos", "gpu_renderer": "ANGLE (Apple, Direct3D11)", "headless": False}, host="darwin")
    assert "gpu-platform" not in codes(
        {"platform": "windows", "gpu_renderer": "ANGLE (Intel, Intel(R) UHD Direct3D11)", "headless": False})


def test_software_gpu_string():
    assert "gpu-software" in codes({"gpu_renderer": "ANGLE (Google, Vulkan SwiftShader Device)", "headless": False})


def test_brand_and_version_vs_build():
    assert "brand-mismatch" in codes({"brand": "edge", "headless": False})
    assert "brand-mismatch" not in codes({"brand": "chrome", "headless": False})
    assert "version-mismatch" in codes({"brand_version": "146", "headless": False})
    assert "version-mismatch" not in codes({"brand_version": "149.0.1", "headless": False})


def test_disable_gpu_needs_noise_off():
    assert "gpu-noise" in codes({"disable_gpu_fingerprint": True, "headless": False})
    assert "gpu-noise" not in codes({"disable_gpu_fingerprint": True, "fingerprint_noise": False, "headless": False})


def test_headless_render_note():
    assert "headless-render" in codes({"headless": True})
    assert "headless-render" not in codes({"headless": False})
    assert "headless-render" not in codes({"headless": True, "canvas_bridge": {"url": "ws://h:1"}})
    assert "headless-render" not in codes({"headless": True, "disable_gpu_fingerprint": True})


def test_bridge_without_gpu_pin_note():
    assert "bridge-no-gpu" in codes({"canvas_bridge": {"url": "ws://h:1"}, "headless": False})
    assert "bridge-no-gpu" not in codes(
        {"canvas_bridge": {"url": "ws://h:1"}, "gpu_renderer": "ANGLE (Intel)", "headless": False})


def test_automation_arg_readded():
    assert "automation-arg" in codes({"_user_args": ["--enable-automation"], "headless": False})
    assert "automation-arg" in codes({"_user_args": ["--remote-debugging-port=9222"], "headless": False})
    assert "automation-arg" not in codes({"_user_args": ["--no-sandbox"], "headless": False})


def _codes(opts):
    return {w["code"] for w in coherence_warnings(opts)}


def test_narrow_gpu_and_canvas_switch_warnings():
    """The r12 halves each carry their own advice, and neither contradicts the other.

    The subtle one is the LAST assertion: gpu-noise used to say "pair with fingerprint_noise=
    False" unconditionally, which told an operator who had ALREADY set canvas_noise=False to go
    and turn off more. It must stand down once the relevant noise is off.
    """
    # The narrow GPU switch leaves readPixels noised, so its advice differs from the wide flag's.
    c = _codes({"gpu_string_spoof": False})
    assert "gpu-noise-string" in c
    assert "gpu-noise" not in c          # the wide flag's warning must not double-fire
    assert "gpu-string-only" in c        # names the WebGL-vs-WebGPU split the narrow switch opens

    # canvas_noise=False must surface the toBlob gap, which neither switch gates.
    assert "canvas-noise-toblob" in _codes({"canvas_noise": False})

    # Already-correct configurations must not be nagged.
    assert "gpu-noise-string" not in _codes({"gpu_string_spoof": False, "fingerprint_noise": False})
    assert "gpu-noise" not in _codes({"disable_gpu_fingerprint": True, "canvas_noise": False})
    # ...but the wide flag on its own still warns, exactly as before.
    assert "gpu-noise" in _codes({"disable_gpu_fingerprint": True})
