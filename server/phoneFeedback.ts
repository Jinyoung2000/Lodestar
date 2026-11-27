import type { PhoneElement, PhoneFeedbackRequest } from "../shared/mobile";
import type { UserAttachment } from "../shared/protocol";

export function phoneFeedbackPrompt(request: PhoneFeedbackRequest): string {
  const { screen, element } = request;
  const lines = [
    `Feedback from the Lodestar phone app: ${request.text}`,
    "",
    "The user sent this from the phone app itself (`mobile/`, Expo React Native), so the change belongs in the phone app unless the feedback clearly needs the daemon too.",
    "",
    "The screen when the feedback was sent:",
    `- Route: ${request.route || "/"}`,
    `- Window: ${screen.width}x${screen.height} dp, font scale ${screen.fontScale}, ${screen.scheme} theme, ${screen.platform}`,
    `- App: ${screen.appVersion ?? "unknown version"}, update ${screen.updateId ?? "embedded bundle"}`,
    ...(request.images?.length ? ["- A screenshot of the whole screen is attached as an image. The tapped spot is marked with a ring."] : ["- Screenshot: not available on this app build"]),
    "",
    ...(element ? elementLines(element) : ["The user did not pick an element. Work out which part of the screen they mean from the feedback and the route."]),
    "",
    "Change the source so the feedback is satisfied, within the design-system tokens and the rules in AGENTS.md and CONTRIBUTING.md.",
    "Then run the phone app checks (`npm run typecheck` and `npm test` inside `mobile/`, plus the root checks if you touched `server/` or `shared/`), check the screen on an emulator when the layout changed, and commit.",
    "Finally deliver it to the phone as an over-the-air update the way the operator normally publishes one (`mobile/scripts/ota-plan.mjs` says whether the change can ship over the air). If it needs a new APK, say so instead of publishing.",
  ];
  return lines.join("\n");
}

function elementLines(element: PhoneElement): string[] {
  const { tap, frame } = element;
  return [
    "The user tapped this element:",
    `- Tap point: (${tap.x}, ${tap.y})`,
    `- Element frame: ${frame ? `x ${frame.x}, y ${frame.y}, ${frame.width}x${frame.height}` : "unknown"}`,
    `- Native view: ${element.nodeName ?? "unknown"}`,
    ...(element.label ? [`- Accessibility label: ${element.label}`] : []),
    ...(element.nativeId ? [`- nativeID: ${element.nativeId}`] : []),
    `- Text inside or near it: ${element.texts.length ? element.texts.map((t) => JSON.stringify(t)).join(", ") : "none"}`,
    `- Component chain, innermost first: ${element.components.length ? element.components.join(" < ") : "unknown"} (names come from the running bundle and may be shortened, so search for the texts too)`,
  ];
}

export function phoneElementChip(element: PhoneElement | null): Extract<UserAttachment, { kind: "element" }> | undefined {
  if (!element) return undefined;
  const named = element.components.find((name) => /^[A-Z]/.test(name) && name.length > 2);
  const label = element.label ?? named ?? element.texts[0] ?? element.nodeName ?? "Element";
  return { kind: "element", label: label.slice(0, 60), path: null, line: null };
}
