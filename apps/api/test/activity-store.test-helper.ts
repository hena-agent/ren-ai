import { DurableObject } from "cloudflare:workers";
import { activityHandler } from "../src/metrics/activity.ts";
import { storageMeter } from "./storage-meter.test-helper.ts";

export class ActivityStore extends DurableObject<Record<string, never>> {
  private meter = storageMeter(this.ctx.storage);
  private handler = activityHandler(this.ctx.storage);

  override async fetch(request: Request) {
    this.meter.reset();
    const response = await this.handler(request);
    const totals = this.meter.totals();
    response.headers.set("X-Rows-Read", String(totals.reads));
    response.headers.set("X-Rows-Written", String(totals.writes));
    return response;
  }
}
