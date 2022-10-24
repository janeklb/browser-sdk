import { isElement } from './node.typeGuards'

describe('isElement', () => {
  const parameters: Array<[Node, boolean]> = [
    [document.createElement('div'), true],
    [document.body, true],
    [document.createTextNode('hello'), false],
    [document.createComment('hello'), false],
  ]

  parameters.forEach(([element, result]) => {
    it(`should return ${String(result)} for "${String(element)}"`, () => {
      expect(isElement(element)).toBe(result)
    })
  })
})
