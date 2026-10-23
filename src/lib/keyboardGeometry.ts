/** Controller height is bottom occlusion in the edge-to-edge window, including
 * its navigation area. Subtract the viewport's distance from that bottom once.
 * This is not a keyboard frame reconstructed from a height.
 */
export function keyboardViewportOverlap(
  bottomOcclusion: number,
  windowHeight: number,
  viewportTop: number,
  viewportHeight: number,
): number {
  'worklet';
  return Math.min(Math.max(0, viewportHeight), Math.max(0,
    bottomOcclusion - Math.max(0, windowHeight - viewportTop - viewportHeight),
  ));
}
