import { Schema } from "effect";
import { MetricsQuery, koreaDay, type Metrics } from "@ren-ai/onboarding";
import type { ManagementClient } from "./contact-client.ts";
import { GenerationError, operation, reportFailure, requestId } from "./logging.ts";
import { html } from "./html-response.ts";
import { renderPage } from "./page.tsx";

export async function metricsRoutes(request: Request, client?: ManagementClient) {
  const params = new URL(request.url).searchParams;
  const period = params.get("period");
  const end = Date.now() - (period === "yesterday" ? 86_400_000 : 0);
  const days = period === "7" ? 7 : period === "30" ? 30 : 1;
  let query: MetricsQuery = { from: koreaDay(end - (days - 1) * 86_400_000), to: koreaDay(end) };
  let metrics: Metrics | undefined;
  try {
    query = Schema.decodeUnknownSync(MetricsQuery)({
      from: params.get("from") ?? query.from,
      to: params.get("to") ?? query.to,
      ...(params.get("breakdown") && { breakdown: params.get("breakdown") }),
    });
    if (!client?.metrics)
      throw new GenerationError("지표 API 연결 설정이 필요합니다.", {
        code: "management_unconfigured",
      });
    metrics = await operation("management.metrics", {}, () => client.metrics!(query));
    return html(renderPage({ personas: [], metricsView: { metrics, query } }));
  } catch (cause) {
    reportFailure(cause, { stage: "metrics.read" });
    return html(
      renderPage({
        personas: [],
        metricsView: { query },
        error: `지표를 불러올 수 없습니다. 날짜와 API 연결을 확인해 주세요. 요청 ID: ${requestId()}`,
      }),
      503,
    );
  }
}
