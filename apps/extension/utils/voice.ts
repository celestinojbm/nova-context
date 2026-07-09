/**
 * Push-to-talk recorder (M1). Records mic audio via MediaRecorder while the
 * user holds the talk button. The recording lives only in memory; it is
 * uploaded once for transcription and then discarded. Raw audio is never
 * stored unless the user explicitly chooses to (no such option exists yet).
 */
export class PushToTalkRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private stream: MediaStream | null = null;

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  async start(): Promise<void> {
    if (this.recording) return;
    // Prompts Chrome's mic permission for the extension origin on first use.
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm",
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  /** Stop and return the recorded clip; releases the mic immediately. */
  async stop(): Promise<Blob | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state !== "recording") {
      this.release();
      return null;
    }
    const done = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await done;
    const blob = new Blob(this.chunks, { type: recorder.mimeType });
    this.release();
    // Ignore accidental taps that produce a near-empty clip.
    return blob.size > 1000 ? blob : null;
  }

  release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}
