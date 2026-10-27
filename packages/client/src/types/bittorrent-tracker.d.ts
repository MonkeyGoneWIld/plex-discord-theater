/** What sideShare.ts uses of bittorrent-tracker's browser client. */
declare module "bittorrent-tracker" {
  interface TrackerClientOptions {
    infoHash: Uint8Array | string;
    peerId: Uint8Array | string;
    announce: string[];
    rtcConfig?: RTCConfiguration;
  }
  export default class TrackerClient {
    constructor(opts: TrackerClientOptions);
    on(event: "peer", listener: (peer: import("../lib/sideShare").SideConnection) => void): this;
    on(event: "warning" | "error", listener: (err: unknown) => void): this;
    start(): void;
    destroy(): void;
  }
}
