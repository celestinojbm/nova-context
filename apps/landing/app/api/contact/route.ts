import { handleContactPost } from "../../../lib/sheets-contact";

export function POST(request: Request): Promise<Response> {
  return handleContactPost(request);
}
