"""Packaging guards: the three version fields agree, and the `mcp` dependency is capped at the next
major (an uncapped `mcp[cli]>=1.2` is what let pip resolve the incompatible mcp 2.x for 0.1.0)."""
import json
import pathlib
import re

import clearcote_mcp

ROOT = pathlib.Path(__file__).resolve().parents[1]
PYPROJECT = (ROOT / "pyproject.toml").read_text(encoding="utf-8")


def _dependency(name: str) -> str:
    deps = re.search(r"^dependencies\s*=\s*\[(.*?)^\]", PYPROJECT, re.M | re.S).group(1)
    for spec in re.findall(r'"([^"]+)"', deps):
        if re.match(rf"{re.escape(name)}(\[|[<>=!~ ]|$)", spec):
            return spec
    raise AssertionError(f"{name} is not a dependency")


def test_versions_agree():
    py = re.search(r'^version\s*=\s*"([^"]+)"', PYPROJECT, re.M).group(1)
    npm = json.loads((ROOT / "npm" / "package.json").read_text(encoding="utf-8"))["version"]
    assert clearcote_mcp.__version__ == py == npm


def test_mcp_dependency_has_an_upper_bound():
    assert "<" in _dependency("mcp"), "cap mcp at the next major: an unreleased major can break the import"


def test_clearcote_floor_supports_free_keys():
    floor = re.search(r">=\s*([\d.]+)", _dependency("clearcote")).group(1)
    assert tuple(int(p) for p in floor.split(".")) >= (0, 30), "free-tier keys need clearcote 0.30.0+"
