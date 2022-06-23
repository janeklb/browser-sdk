import { Observable, timeStampNow } from '@datadog/browser-core'
import { createNewEvent } from '../../core/test/specHelper'

export type FakeClick = Readonly<ReturnType<typeof createFakeClick>>

export function createFakeClick({
  hasError = false,
  hasPageActivity = true,
  userActivity,
  event,
}: {
  hasError?: boolean
  hasPageActivity?: boolean
  userActivity?: { selection?: boolean }
  event?: Partial<MouseEvent & { target: Element }>
} = {}) {
  const stopObservable = new Observable<void>()
  let isStopped = false

  function clone() {
    return createFakeClick({ userActivity, event })
  }

  return {
    stopObservable,
    isStopped: () => isStopped,
    stop: () => {
      isStopped = true
      stopObservable.notify()
    },
    discard: jasmine.createSpy(),
    validate: jasmine.createSpy(),
    hasError,
    hasPageActivity,
    getUserActivity: () => ({
      selection: false,
      ...userActivity,
    }),
    addFrustration: jasmine.createSpy(),
    clone: jasmine.createSpy<typeof clone>().and.callFake(clone),

    event: createNewEvent('click', {
      clientX: 100,
      clientY: 100,
      timeStamp: timeStampNow(),
      target: document.body,
      ...event,
    }),
  }
}
