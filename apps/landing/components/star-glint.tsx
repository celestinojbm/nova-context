"use client";

import { useEffect, useRef } from "react";

const VERT = "attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}";
const FRAG = `precision mediump float;uniform float u_t;uniform vec2 u_res;void main(){vec2 uv=gl_FragCoord.xy/u_res;float sweep=uv.x*0.85+uv.y*0.35;float band=smoothstep(0.2,0.0,abs(sweep-u_t));float lit=mix(0.93,1.0,band*0.9);gl_FragColor=vec4(lit,lit,lit,1.0);}`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Optional desktop sheen. The SVG star is the drawing; this only tints it. */
export function StarGlint({ onReady }: { onReady: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      powerPreference: "low-power",
    });
    if (!gl) return;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "a");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const uTime = gl.getUniformLocation(program, "u_t");
    const uRes = gl.getUniformLocation(program, "u_res");

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(parent.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(parent.clientHeight * dpr));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(parent);

    let frame = 0;
    let running = true;
    let told = false;
    const started = performance.now();
    const draw = (now: number) => {
      if (!running) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(uTime, ((now - started) % 6000) / 6000);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!told) {
        told = true;
        onReady();
      }
      frame = requestAnimationFrame(draw);
    };

    const onHide = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(frame);
      } else if (!running) {
        running = true;
        frame = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onHide);
    const visibility = new IntersectionObserver((entries) => {
      const onScreen = entries.some((entry) => entry.isIntersecting);
      if (!onScreen) {
        running = false;
        cancelAnimationFrame(frame);
      } else if (!running && !document.hidden) {
        running = true;
        frame = requestAnimationFrame(draw);
      }
    });
    visibility.observe(parent);
    frame = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onHide);
      visibility.disconnect();
      observer.disconnect();
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (buffer) gl.deleteBuffer(buffer);
    };
  }, [onReady]);

  return <canvas ref={ref} className="star-glint" aria-hidden="true" />;
}
