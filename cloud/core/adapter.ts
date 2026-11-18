// Phase 0: the existing comment routes only. Authentication, transport and body limits stay with each adapter.
export interface CoreRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body(): Promise<unknown>;
}

export interface CoreResponse { status: number; body: unknown }

export interface Adapter {
  kind: "cloudflare" | "mac" | "memory";
  team(): { hasDoc(doc: string): boolean | Promise<boolean> };
  room(doc: string): {
    read(req: CoreRequest): CoreResponse | Promise<CoreResponse>;
    submit(req: CoreRequest): CoreResponse | Promise<CoreResponse>;
  };
}
