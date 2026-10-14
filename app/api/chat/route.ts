import { POST as answerQuestion } from '../openlibrary/ask/route';

// Keep the conversation UI and the project ask panel on the same graph-backed path.
export async function POST(request: Request) {
  return answerQuestion(request);
}
