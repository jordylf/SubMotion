import type { Frame, SourceCaption } from './types.ts';
import type { HostCaption, HostJob } from './pipeline.ts';
import type { MediaPlacement } from './transcript/index.ts';

export type HostApp = 'aftereffects' | 'premiere' | 'browser';

export interface TemplateSpec {
  width: number;
  height: number;
  file: string;
  fontSize: number;
  positionYPct: number;
  maxWidthPct: number;
}

/**
 * Contract between the core and an Adobe host. Calls are batch-shaped on purpose: every
 * panel→host round trip costs IPC time, so per-property calls (setFont, setPosition...) would make
 * a 2000-caption run crawl. The ExtendScript side (src/after-effects/host.jsx, src/premiere/host.jsx)
 * implements the per-layer work.
 */
export interface AdobeHostAdapter {
  app: HostApp;
  frameInfo(): Promise<Frame & { name: string; fps?: number }>;
  /** Host-native caption source (AE: selected text layers). Premiere has no caption read API. */
  readSourceCaptions(): Promise<SourceCaption[]>;
  /** Selected clip/layer media + timeline mapping, for transcription. */
  mediaSource(): Promise<MediaPlacement>;
  /** Installed fonts as [postScriptName, family, style] (AE only; Premiere returns []). */
  listFonts(): Promise<[string, string, string][]>;
  prepare(job: HostJob): Promise<void>; // removes previous SubMotion output, creates containers/controls
  createBatch(captions: HostCaption[]): Promise<number>;
  finish(): Promise<void>;
  deleteGenerated(): Promise<number>;
  /** AE only: builds ONE Premiere template and starts its (asynchronous) export to a staging file. */
  buildTemplate(arg: { job: HostJob; template: TemplateSpec }): Promise<{ staged: string; file: string }>;
  templateFolder(): string;
}

interface CepRuntime {
  evalScript(script: string, cb: (result: string) => void): void;
  getHostEnvironment(): string;
  getSystemPath(type: string): string;
}

const json = (v: unknown) => JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** CEP implementation: forwards every call to SM.call(fn, arg) in src/host/main.jsx. */
export class CepHost implements AdobeHostAdapter {
  app: HostApp;
  private cep: CepRuntime;

  constructor(cep: CepRuntime) {
    this.cep = cep;
    const appName = JSON.parse(cep.getHostEnvironment()).appName;
    this.app = appName === 'AEFT' ? 'aftereffects' : 'premiere';
  }

  private call<T>(fn: string, arg: unknown = null): Promise<T> {
    return new Promise((resolve, reject) => {
      this.cep.evalScript(`SM.call(${json(fn)}, ${json(arg)})`, (raw) => {
        let res: { ok: boolean; data?: T; error?: string };
        try {
          res = JSON.parse(raw);
        } catch {
          return reject(new Error(raw === 'EvalScript error.'
            ? 'The host app refused to run SubMotion scripts. Restart the app (Premiere/After Effects) and reopen the SubMotion panel.'
            : `Host script failed (${raw}).`));
        }
        if (res.ok) resolve(res.data as T);
        else reject(new Error(res.error));
      });
    });
  }

  frameInfo() { return this.call<Frame & { name: string; fps?: number }>('frameInfo'); }
  /** Premiere only: run SM.call(fn, payload) in After Effects over BridgeTalk. */
  aeCall<T>(fn: string, payload: unknown = null, reload = false) {
    return this.call<T>('aeCall', { fn, payload, reload, main: this.extensionPath() + '/src/host/main.jsx' });
  }
  /** Premiere only: link the saved AE caption comp and put it on the timeline. */
  dlPlace(aepPath: string) { return this.call<{ track: number }>('dlPlace', { aepPath }); }
  readSourceCaptions() { return this.call<SourceCaption[]>('readSourceCaptions'); }
  mediaSource() { return this.call<MediaPlacement>('mediaSource'); }
  listFonts() { return this.call<[string, string, string][]>('listFonts'); }
  prepare(job: HostJob) { return this.call<void>('prepare', job); }
  createBatch(captions: HostCaption[]) { return this.call<number>('createBatch', captions); }
  finish() { return this.call<void>('finish'); }
  deleteGenerated() { return this.call<number>('deleteGenerated'); }
  buildTemplate(arg: { job: HostJob; template: TemplateSpec }) { return this.call<{ staged: string; file: string }>('buildTemplate', arg); }

  extensionPath(): string {
    return decodeURI(this.cep.getSystemPath('extension'))
      .replace(/^file:\/\/\/(?=[A-Za-z]:)/, '')
      .replace(/^file:\/\//, '');
  }

  templateFolder(): string {
    return this.extensionPath() + '/assets/mogrt';
  }

  private loaded = false;

  /**
   * (Re)loads the host scripts once per panel session. The host's ExtendScript engine outlives the
   * panel, so without this an updated extension would keep running the old host code until restart.
   */
  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    const main = json(this.extensionPath() + '/src/host/main.jsx');
    return new Promise((resolve) =>
      this.cep.evalScript(`$.evalFile(${main}); "loaded"`, () => {
        this.loaded = true;
        resolve();
      }),
    );
  }
}
