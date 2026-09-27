// Live render-backend coherence probe (#7) - the page-level counterpart to the launch-time heuristic
// in warnings. Reads what the page actually sees from WebGL and checks the two render-coherence tells
// a strict detector looks for: a software rasterizer (SwiftShader/llvmpipe/Mesa OffScreen - fatal on
// a "stealth" build), and an incoherent vendor/renderer GPU-family pair. It cannot read the real host
// GPU when the persona spoofs the unmasked strings (that's the point of the spoof) - it verifies the
// values the page is allowed to see are internally coherent and not a software fallback. For the
// deeper "do the pixels match the claimed GPU class" check, route paints through the canvas bridge.

import type { Page } from "playwright-core";

/** Probe JS - reads VENDOR/RENDERER + the unmasked pair via a throwaway WebGL context. */
const PROBE_JS = `() => {
  const out = { webgl: false, webgl2: false, vendor: "", renderer: "",
                unmaskedVendor: "", unmaskedRenderer: "", maxTextureSize: 0 };
  try {
    const c = document.createElement('canvas');
    const gl2 = c.getContext('webgl2');
    const gl = gl2 || c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return out;
    out.webgl = true;
    out.webgl2 = !!gl2;
    out.vendor = gl.getParameter(gl.VENDOR) || "";
    out.renderer = gl.getParameter(gl.RENDERER) || "";
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      out.unmaskedVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || "";
      out.unmaskedRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "";
    }
    out.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
    out.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 0;
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    out.maxViewportDims = vp ? Array.from(vp) : [];
    out.maxVertexUniformVectors = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) || 0;
    out.maxFragmentUniformVectors = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) || 0;
    // Capability probe, not a declared value: a spoofed renderer string is free, an actual
    // 16384-wide texture allocation is not. A software-rasterizer backend refuses it.
    // The error queue is drained first: getError() is sticky, so a flag left behind by anything
    // above would otherwise be read back as "the allocation failed".
    try {
      let drain = 0;
      while (gl.getError() !== gl.NO_ERROR && drain++ < 32) {}
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 16384, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      out.canAllocate16k = gl.getError() === gl.NO_ERROR;
      gl.deleteTexture(t);
    } catch (e) { out.canAllocate16k = null; }
  } catch (e) { out.error = String(e); }
  return out;
}`;

const SOFTWARE_MARKERS = [
  "swiftshader", "google swiftshader", "llvmpipe", "softpipe",
  "mesa offscreen", "microsoft basic render", "software adapter",
];

const FAMILY_KEYS: [string, string][] = [
  ["nvidia", "nvidia"], ["geforce", "nvidia"], ["rtx", "nvidia"], ["gtx", "nvidia"], ["quadro", "nvidia"],
  ["radeon", "amd"], ["amd", "amd"], ["ati ", "amd"],
  ["intel", "intel"], ["iris", "intel"], ["uhd graphics", "intel"], ["hd graphics", "intel"],
  ["apple", "apple"], ["m1", "apple"], ["m2", "apple"], ["m3", "apple"], ["m4", "apple"],
  ["mali", "mali"], ["adreno", "adreno"], ["powervr", "powervr"],
];

// Desktop/laptop GPU families. A persona naming one of these claims a machine whose driver backs a
// 16384 texture; the mobile families legitimately sit below that, so the floor skips them.
const DESKTOP_FAMILIES = ["nvidia", "amd", "intel", "apple"];

// Capability floor for a desktop-class GPU claim, measured rather than assumed:
//   SwiftShader (ANGLE/Vulkan, genuine Chrome 153 headless Linux) ....... 8192
//   Mesa llvmpipe (LLVM 15, genuine Chrome 153 headed Linux) ........... 16384
//   ANGLE/D3D11 on a GeForce RTX 3070 (genuine Chrome 153 Windows) ..... 16384
// 16384 is also the D3D11 feature-level-11 2D texture cap and the Mesa GL limit for Intel Gen7+.
const HW_MIN_MAX_TEXTURE_SIZE = 16384;

/** Best-effort GPU family from a vendor/renderer string ('' if unknown). */
export function gpuFamily(s: string | undefined): string {
  const l = (s || "").toLowerCase();
  for (const [key, fam] of FAMILY_KEYS) if (l.includes(key)) return fam;
  return "";
}

export interface RenderInfo {
  webgl?: boolean;
  webgl2?: boolean;
  vendor?: string;
  renderer?: string;
  unmaskedVendor?: string;
  unmaskedRenderer?: string;
  maxTextureSize?: number;
  maxRenderbufferSize?: number;
  maxViewportDims?: number[];
  maxVertexUniformVectors?: number;
  maxFragmentUniformVectors?: number;
  canAllocate16k?: boolean | null;
}

export interface RenderVerdict {
  vendor: string;
  renderer: string;
  webgl: boolean;
  webgl2: boolean;
  maxTextureSize: number;
  maxRenderbufferSize: number;
  maxVertexUniformVectors: number;
  maxFragmentUniformVectors: number;
  canAllocate16kTexture?: boolean | null;
  softwareSuspected: boolean;
  coherent: boolean;
  warnings: string[];
}

/** Pure analysis of a probe result -> coherence verdict (unit-testable, no Playwright). */
export function evaluateRenderInfo(info: RenderInfo, claimedGpu?: string): RenderVerdict {
  const renderer = info.unmaskedRenderer || info.renderer || "";
  const vendor = info.unmaskedVendor || info.vendor || "";
  const rl = renderer.toLowerCase();
  const vl = vendor.toLowerCase();
  const warnings: string[] = [];

  const hasWebgl = !!info.webgl;
  if (!hasWebgl) {
    warnings.push(
      "WebGL is unavailable - a hard tell for a real desktop browser (only headless or locked-down setups disable it)."
    );
  }

  let software = SOFTWARE_MARKERS.some((m) => rl.includes(m) || vl.includes(m));
  if (software) {
    warnings.push(
      `software rasterizer detected in the WebGL renderer (${JSON.stringify(renderer)}) - a definitive ` +
        "headless/no-GPU tell. Enable the canvas bridge (canvasBridge: ...) or run headed on a machine with a real GPU."
    );
  }

  const rfam = gpuFamily(rl);
  const vfam = gpuFamily(vl);

  // Capability floor. The string check above is defeated the moment the persona renames the
  // backend, so verify the claim against a limit the renderer string cannot move: a software
  // rasterizer reports (and allocates) 8192 where every desktop GPU does 16384.
  const maxTex = info.maxTextureSize || 0;
  const can16k = info.canAllocate16k;
  const vuv = info.maxVertexUniformVectors || 0;
  const fuv = info.maxFragmentUniformVectors || 0;
  if (DESKTOP_FAMILIES.includes(rfam) && maxTex && maxTex < HW_MIN_MAX_TEXTURE_SIZE) {
    software = true;
    warnings.push(
      `the WebGL renderer names a desktop GPU (${JSON.stringify(renderer)}) but MAX_TEXTURE_SIZE is ` +
        `${maxTex}, below the ${HW_MIN_MAX_TEXTURE_SIZE} current desktop drivers report (only ` +
        "pre-feature-level-11 D3D parts cap at 8192) - on a stealth build this means the renderer " +
        "string was spoofed over a software rasterizer (headless Linux falls back to SwiftShader). " +
        "Run headed, or use the canvas bridge."
    );
  } else if (DESKTOP_FAMILIES.includes(rfam) && can16k === false) {
    software = true;
    warnings.push(
      `the WebGL renderer names a desktop GPU (${JSON.stringify(renderer)}) and reports ` +
        `MAX_TEXTURE_SIZE ${maxTex}, but a ${HW_MIN_MAX_TEXTURE_SIZE}-wide texture fails to ` +
        "allocate - the reported limit is not backed by the real rendering backend."
    );
  }

  // Uniform-vector split: an ANGLE-over-GL/Mesa renderer reports vertex == fragment on every real
  // driver (measured: SwiftShader 4096/4096, llvmpipe 1024/1024). ANGLE/D3D11 legitimately differs
  // (4095/1024), so the check is limited to the non-D3D backends.
  let incoherent = false;
  if (vuv && fuv && vuv !== fuv && !rl.includes("d3d") && !rl.includes("direct3d")) {
    incoherent = true;
    warnings.push(
      `MAX_VERTEX_UNIFORM_VECTORS (${vuv}) and MAX_FRAGMENT_UNIFORM_VECTORS (${fuv}) disagree under ` +
        `a non-D3D renderer (${JSON.stringify(renderer)}); every GL backend measured here reports ` +
        "them equal (SwiftShader 4096/4096, llvmpipe 1024/1024), so the persona applied to one and " +
        "not the other."
    );
  }

  if (rfam && vfam && rfam !== vfam) {
    incoherent = true;
    warnings.push(
      `WebGL vendor and renderer disagree on GPU family (vendor~${vfam}, renderer~${rfam}) - an incoherent persona.`
    );
  }

  if (claimedGpu) {
    const cfam = gpuFamily(claimedGpu);
    if (cfam && rfam && cfam !== rfam) {
      incoherent = true;
      warnings.push(
        `the claimed GPU (${JSON.stringify(claimedGpu)}, family ~${cfam}) does not match the WebGL renderer family (~${rfam}).`
      );
    }
  }

  // Set by the branches above rather than by matching warning text: the verdict must not depend on
  // the wording of a message.
  const coherent = hasWebgl && !software && !incoherent;
  return {
    vendor,
    renderer,
    webgl: hasWebgl,
    webgl2: !!info.webgl2,
    maxTextureSize: info.maxTextureSize || 0,
    maxRenderbufferSize: info.maxRenderbufferSize || 0,
    maxVertexUniformVectors: vuv,
    maxFragmentUniformVectors: fuv,
    canAllocate16kTexture: can16k,
    softwareSuspected: software,
    coherent,
    warnings,
  };
}

/**
 * Probe a live Playwright `page` for render-backend coherence (#7). Returns the vendor/renderer the
 * page actually sees, `softwareSuspected` (a SwiftShader/llvmpipe fallback is a fatal tell),
 * `coherent`, and human-readable `warnings`. Pass `claimedGpu` to also assert the rendered family.
 *
 * @example
 * const br = await clearcote.launch({ fingerprint: "77" });
 * const page = await br.newPage(); await page.goto("about:blank");
 * const verdict = await checkRenderCoherence(page);
 * if (!verdict.coherent) console.warn(verdict.warnings);
 */
export async function checkRenderCoherence(page: Page, claimedGpu?: string): Promise<RenderVerdict> {
  const info = (await page.evaluate(PROBE_JS)) as RenderInfo;
  return evaluateRenderInfo(info, claimedGpu);
}
