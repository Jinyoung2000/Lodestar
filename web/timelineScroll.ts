
export const BOTTOM_SLACK = 40;

export function followsBottom(following: boolean, distance: number, resized: boolean): boolean {
  if (resized) return following;
  return distance < BOTTOM_SLACK;
}
