export function isElement(node: Node): node is Element {
  return node.nodeType === node.ELEMENT_NODE
}
