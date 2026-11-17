export interface VercelRequest extends AsyncIterable<Buffer | string> {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface VercelResponse {
  setHeader(name: string, value: string): void;
  status(code: number): this;
  json(body: unknown): this;
  redirect(statusCode: number, url: string): this;
}
