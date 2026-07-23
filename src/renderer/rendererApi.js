/**
 * Methods and state installed after renderer initialization. This explicit
 * contract is required because TypeScript cannot infer properties added with
 * `Object.defineProperties` to the synchronously returned renderer stub.
 *
 * @typedef {object} MantleRendererApi
 * @property {boolean} showTriOutline
 * @property {boolean} showBBoxes
 * @property {(bundle: object|null) => void} setBundle
 * @property {(target?: object) => void} render
 * @property {() => void} invalidateRenderState
 * @property {() => void} markGeometryDirty
 * @property {(enabled: boolean) => void} _setFilterBbox
 * @property {(enabled: boolean) => void} _setFilterScissor
 * @property {(enabled: boolean) => void} _setInstancedFast
 * @property {() => void} dispose
 * @property {boolean} isContextLost
 * @property {(widthPx: number|null, heightPx?: number, dpr?: number) => void} setViewport
 * @property {(scale: number, opts?: {dpr?: number}) => ([number, number]|null)} setResolutionScale
 * @property {number} resolutionScale
 * @property {(clearColor?: [number,number,number,number]|null) => void} beginFrame
 * @property {() => void} endFrame
 * @property {(opts?: object) => Promise<string|object>} exportFrameSVG
 * @property {(enabled: boolean) => boolean} setFrameCapture
 * @property {boolean} frameCaptureEnabled
 * @property {(x: number, y: number, width: number, height: number) => void} setScissorRect
 * @property {() => void} clearScissorRect
 * @property {(texture: object|null) => void} deleteClipTexture
 * @property {(target: object, opts?: object) => object|null} renderClipCoverage
 * @property {(target: object, opts?: object) => void} setNodeClip
 * @property {(target: object) => void} clearNodeClip
 * @property {(target: object, opts?: object) => void} drawBundle
 * @property {(target: object, opts?: object & {zOrder?: number}) => void} submitBundle
 * @property {(bundle: object) => boolean} prepareBundle
 * @property {(bundle: object, timeoutMs?: number) => Promise<boolean>} awaitLbReady
 * @property {(bundle: object) => void} prewarmBundle
 * @property {(bytes: number) => void} setLoopBlinnMemoryBudget
 * @property {(opts?: {forceCdt?: boolean}) => void} setLoopBlinnMeshOpts
 * @property {() => number} getLoopBlinnMemoryUse
 * @property {(bundle: object, opts?: object) => void} drawInstance
 * @property {(source: any, opts?: object) => (object|Promise<object|null>|null)} createImage
 * @property {(source: any, opts?: object) => boolean} drawImage
 * @property {(mesh: object, opts?: object) => boolean} drawLoopBlinnMesh
 * @property {(mode?: 'off'|'auto'|'on'|'only'|boolean) => void} setLoopBlinnFill
 * @property {(mode?: 'off'|'auto'|'on'|'only'|boolean) => void} setLoopBlinnMorphFill
 * @property {(source: any, instances: object[], opts?: object) => number} drawImageInstanced
 * @property {(target: object, instances: object[], opts?: object) => number} drawBundleInstanced
 * @property {(target: object, sprite: string|[number,number], opts?: object) => boolean} drawSprite
 * @property {(target: object, sprite: string|[number,number], instances: object[], opts?: object) => number} drawSpriteInstanced
 * @property {(bundle: object, opts?: object) => object} createBundleHandle
 * @property {() => number} precompileFills
 * @property {(opts: object) => object} createIncrementalStroke
 * @property {() => number} gpuMemoryEstimate
 * @property {object} debugStats
 * @property {(opts?: object) => boolean} enableStaticCache
 * @property {(key: string|null) => void} setInstanceGroup
 * @property {() => void} disableStaticCache
 * @property {() => void} invalidateStaticCache
 * @property {object|null} staticCache
 */

/**
 * Public surface returned by `createRenderer()`.
 * @typedef {MantleRendererApi & {ready: Promise<MantleRenderer>}} MantleRenderer
 */

export {};
