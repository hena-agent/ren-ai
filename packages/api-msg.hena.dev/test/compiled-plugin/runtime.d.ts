declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch(request: Request): Promise<Response>;
  }): void;
};
