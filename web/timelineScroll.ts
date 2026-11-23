export const BOTTOM_SLACK = 40;

export function followsBottom(following: boolean, distance: number, resized: boolean, movedUp = false): boolean {
  if (resized) return following;
  if (movedUp) return false;
  return distance < BOTTOM_SLACK;
}
