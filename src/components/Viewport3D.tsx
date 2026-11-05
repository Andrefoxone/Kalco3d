import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type * as THREE from "three";
import {
  ViewportScene,
  type BackgroundPreset,
  type CameraView,
  type CapturedView,
  type LightingPreset,
  type LoadState,
  type MaterialStyle,
  type SculptMode,
  type TransformMode,
} from "@/three/scene";
import type { PrintReport } from "@/three/printCheck";
import type { PrintInput } from "@/print/pipeline";

export interface ViewportHandle {
  loadModel: (url: string) => Promise<boolean>;
  setModelFromObject: (obj: THREE.Object3D) => boolean;
  hasModel: () => boolean;
  setWireframe: (on: boolean) => void;
  setAutoRotate: (on: boolean) => void;
  resetCamera: () => void;
  setView: (view: CameraView) => void;
  setTransformMode: (mode: TransformMode | null) => void;
  setSculptMode: (mode: SculptMode | null) => void;
  setSculptParams: (radius: number, strength: number) => void;
  setSculptSymmetry: (on: boolean) => void;
  applyMaterialStyle: (style: MaterialStyle) => void;
  setBackground: (preset: BackgroundPreset) => void;
  setLighting: (preset: LightingPreset) => void;
  setGridVisible: (visible: boolean) => void;
  undo: () => boolean;
  redo: () => boolean;
  getStats: () => { vertices: number; triangles: number };
  exportGLB: () => Promise<ArrayBuffer | null>;
  exportSTL: (longestMm?: number) => ArrayBuffer | null;
  exportUSDZ: (longestMm?: number) => Promise<ArrayBuffer | null>;
  analyzePrint: () => PrintReport | null;
  getSourceMaxDim: () => number | null;
  getPrintInput: () => PrintInput | null;
  captureViews: (only?: string[]) => CapturedView[];
}

interface Props {
  onStateChange?: (state: LoadState) => void;
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
}

export const Viewport3D = forwardRef<ViewportHandle, Props>(function Viewport3D(
  { onStateChange, onHistoryChange },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewportScene | null>(null);
  const stateCb = useRef(onStateChange);
  stateCb.current = onStateChange;
  const historyCb = useRef(onHistoryChange);
  historyCb.current = onHistoryChange;

  useEffect(() => {
    if (!containerRef.current) return;
    const scene = new ViewportScene(containerRef.current, {
      onStateChange: (s) => stateCb.current?.(s),
      onHistoryChange: (u, r) => historyCb.current?.(u, r),
    });
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    loadModel: (url: string) => sceneRef.current?.loadModel(url) ?? Promise.resolve(false),
    setModelFromObject: (obj: THREE.Object3D) => sceneRef.current?.setModelFromObject(obj) ?? false,
    hasModel: () => sceneRef.current?.hasModel() ?? false,
    setWireframe: (on: boolean) => sceneRef.current?.setWireframe(on),
    setAutoRotate: (on: boolean) => sceneRef.current?.setAutoRotate(on),
    resetCamera: () => sceneRef.current?.resetCamera(),
    setView: (view: CameraView) => sceneRef.current?.setView(view),
    setTransformMode: (mode: TransformMode | null) => sceneRef.current?.setTransformMode(mode),
    setSculptMode: (mode: SculptMode | null) => sceneRef.current?.setSculptMode(mode),
    setSculptParams: (radius: number, strength: number) =>
      sceneRef.current?.setSculptParams(radius, strength),
    setSculptSymmetry: (on: boolean) => sceneRef.current?.setSculptSymmetry(on),
    applyMaterialStyle: (style: MaterialStyle) => sceneRef.current?.applyMaterialStyle(style),
    setBackground: (preset: BackgroundPreset) => sceneRef.current?.setBackground(preset),
    setLighting: (preset: LightingPreset) => sceneRef.current?.setLighting(preset),
    setGridVisible: (visible: boolean) => sceneRef.current?.setGridVisible(visible),
    undo: () => sceneRef.current?.undo() ?? false,
    redo: () => sceneRef.current?.redo() ?? false,
    getStats: () => sceneRef.current?.getStats() ?? { vertices: 0, triangles: 0 },
    exportGLB: () => sceneRef.current?.exportGLB() ?? Promise.resolve(null),
    exportSTL: (mm?: number) => sceneRef.current?.exportSTL(mm) ?? null,
    exportUSDZ: (mm?: number) => sceneRef.current?.exportUSDZ(mm) ?? Promise.resolve(null),
    analyzePrint: () => sceneRef.current?.analyzePrint() ?? null,
    getSourceMaxDim: () => sceneRef.current?.getSourceMaxDim() ?? null,
    getPrintInput: () => sceneRef.current?.getPrintInput() ?? null,
    captureViews: (only?: string[]) => sceneRef.current?.captureViews(only) ?? [],
  }));

  return <div ref={containerRef} className="absolute inset-0" aria-label="Visualizzatore 3D" />;
});
