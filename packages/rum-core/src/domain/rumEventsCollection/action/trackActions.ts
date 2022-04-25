import type { Context, Duration, ClocksState, RelativeTime, TimeStamp, Subscription } from '@datadog/browser-core'
import {
  noop,
  Observable,
  assign,
  isExperimentalFeatureEnabled,
  getRelativeTime,
  ONE_MINUTE,
  ContextHistory,
  addEventListener,
  DOM_EVENT,
  generateUUID,
  clocksNow,
  ONE_SECOND,
  elapsed,
} from '@datadog/browser-core'
import { FrustrationType, ActionType } from '../../../rawRumEvent.types'
import type { RumConfiguration } from '../../configuration'
import type { LifeCycle } from '../../lifeCycle'
import { LifeCycleEventType } from '../../lifeCycle'
import { trackEventCounts } from '../../trackEventCounts'
import { waitIdlePage } from '../../waitIdlePage'
import type { RageClickChain } from './rageClickChain'
import { createRageClickChain } from './rageClickChain'
import { getActionNameFromElement } from './getActionNameFromElement'

type AutoActionType = ActionType.CLICK

interface ActionCounts {
  errorCount: number
  longTaskCount: number
  resourceCount: number
}

export interface CustomAction {
  type: ActionType.CUSTOM
  name: string
  startClocks: ClocksState
  context?: Context
}

export interface AutoAction {
  type: AutoActionType
  id: string
  name: string
  startClocks: ClocksState
  duration?: Duration
  counts: ActionCounts
  event: MouseEvent
  frustrationTypes: FrustrationType[]
}

export interface ActionContexts {
  findActionId: (startTime?: RelativeTime) => string | string[] | undefined
}

// Maximum duration for automatic actions
export const AUTO_ACTION_MAX_DURATION = 10 * ONE_SECOND
export const ACTION_CONTEXT_TIME_OUT_DELAY = 5 * ONE_MINUTE // arbitrary

export function trackActions(
  lifeCycle: LifeCycle,
  domMutationObservable: Observable<void>,
  { actionNameAttribute }: RumConfiguration
) {
  // TODO: this will be changed when we introduce a proper initialization parameter for it
  const collectFrustrations = isExperimentalFeatureEnabled('frustration-signals')
  const history = new ContextHistory<string>(ACTION_CONTEXT_TIME_OUT_DELAY)
  const stopObservable = new Observable<void>()
  let currentRageClickChain: RageClickChain | undefined

  lifeCycle.subscribe(LifeCycleEventType.SESSION_RENEWED, () => {
    history.reset()
  })

  lifeCycle.subscribe(LifeCycleEventType.BEFORE_UNLOAD, () => {
    if (currentRageClickChain) {
      currentRageClickChain.stop()
    }
  })

  const { stop: stopListener } = listenClickEvents(onClick)

  const actionContexts: ActionContexts = {
    findActionId: (startTime?: RelativeTime) =>
      isExperimentalFeatureEnabled('frustration-signals') ? history.findAll(startTime) : history.find(startTime),
  }

  return {
    stop: () => {
      if (currentRageClickChain) {
        currentRageClickChain.stop()
      }
      stopObservable.notify()
      stopListener()
    },
    actionContexts,
  }

  function onClick(event: MouseEvent & { target: Element }) {
    if (!collectFrustrations && history.find()) {
      // TODO: remove this in a future major version. To keep retrocompatibility, ignore any new
      // action if another one is already occurring.
      return
    }

    const name = getActionNameFromElement(event.target, actionNameAttribute)
    if (!collectFrustrations && !name) {
      // TODO: remove this in a future major version. To keep retrocompatibility, ignore any action
      // with a blank name
      return
    }

    const startClocks = clocksNow()

    const singleClickPotentialAction = newPotentialAction(lifeCycle, history, collectFrustrations, {
      name,
      event,
      type: ActionType.CLICK as const,
      startClocks,
    })

    // If we collect frustration, we have to add the click action to a "click chain" which will
    // validate it only if it's not part of a rage click.
    if (
      collectFrustrations &&
      (!currentRageClickChain || !currentRageClickChain.tryAppend(singleClickPotentialAction))
    ) {
      // If we failed to add the click to the current click chain, create a new click chain
      currentRageClickChain = createRageClickChain(singleClickPotentialAction)
    }

    const { stop: stopWaitingIdlePage } = waitIdlePage(
      lifeCycle,
      domMutationObservable,
      (idleEvent) => {
        if (!idleEvent.hadActivity) {
          // If it has no activity, consider it as a dead click.
          // TODO: this will yield a lot of false positive. We'll need to refine it in the future.
          if (collectFrustrations) {
            singleClickPotentialAction.addFrustration(FrustrationType.DEAD)
            singleClickPotentialAction.stop()
          } else {
            singleClickPotentialAction.discard()
          }
        } else if (idleEvent.end < startClocks.timeStamp) {
          // If the clock is looking weird, just discard the action
          singleClickPotentialAction.discard()
        } else if (collectFrustrations) {
          // If we collect frustrations, let's stop the potential action, but validate later
          singleClickPotentialAction.stop(idleEvent.end)
        } else {
          // Else just validate it now
          singleClickPotentialAction.validate(idleEvent.end)
        }
        stopClickProcessing()
      },
      AUTO_ACTION_MAX_DURATION
    )

    let viewCreatedSubscription: Subscription | undefined
    if (!collectFrustrations) {
      // TODO: remove this in a future major version. To keep retrocompatibility, end the action on a
      // new view is created.
      viewCreatedSubscription = lifeCycle.subscribe(LifeCycleEventType.VIEW_CREATED, stopClickProcessing)
    }

    const stopSubscription = stopObservable.subscribe(stopClickProcessing)

    function stopClickProcessing() {
      // Cleanup any ongoing process
      singleClickPotentialAction.stop()
      if (viewCreatedSubscription) {
        viewCreatedSubscription.unsubscribe()
      }
      stopWaitingIdlePage()
      stopSubscription.unsubscribe()
    }
  }
}

function listenClickEvents(callback: (clickEvent: MouseEvent & { target: Element }) => void) {
  return addEventListener(
    window,
    DOM_EVENT.CLICK,
    (clickEvent: MouseEvent) => {
      if (clickEvent.target instanceof Element) {
        callback(clickEvent as MouseEvent & { target: Element })
      }
    },
    { capture: true }
  )
}

const enum PotentialActionStatus {
  // Initial state, the action is still ongoing.
  PENDING,
  // The action is no more ongoing but still needs to be validated or discarded.
  STOPPED,
  // Final state, the action has been stopped and validated or discarded.
  FINALIZED,
}

type PotentialActionState =
  | { status: PotentialActionStatus.PENDING }
  | { status: PotentialActionStatus.STOPPED; endTime?: TimeStamp }
  | { status: PotentialActionStatus.FINALIZED }

export type PotentialAction = ReturnType<typeof newPotentialAction>

function newPotentialAction(
  lifeCycle: LifeCycle,
  history: ContextHistory<string>,
  collectFrustrations: boolean,
  base: Pick<AutoAction, 'startClocks' | 'event' | 'name' | 'type'>
) {
  const id = generateUUID()
  const historyEntry = history.add(id, base.startClocks.relative)
  const eventCountsSubscription = trackEventCounts(lifeCycle)
  let state: PotentialActionState = { status: PotentialActionStatus.PENDING }
  const frustrations = new Set<FrustrationType>()
  let onStopCallback = noop

  function stop(endTime?: TimeStamp) {
    if (state.status !== PotentialActionStatus.PENDING) {
      return
    }
    state = { status: PotentialActionStatus.STOPPED, endTime }
    if (endTime) {
      historyEntry.close(getRelativeTime(endTime))
    } else {
      historyEntry.remove()
    }
    eventCountsSubscription.stop()
    onStopCallback()
  }

  function addFrustration(frustration: FrustrationType) {
    if (collectFrustrations) {
      frustrations.add(frustration)
    }
  }

  return {
    base,
    addFrustration,
    stop,

    getFrustrations: () => frustrations,

    onStop: (newOnStopCallback: () => void) => {
      onStopCallback = newOnStopCallback
    },

    clone: () => newPotentialAction(lifeCycle, history, collectFrustrations, base),

    validate: (endTime?: TimeStamp) => {
      stop(endTime)
      if (state.status !== PotentialActionStatus.STOPPED) {
        return
      }

      if (eventCountsSubscription.eventCounts.errorCount > 0) {
        addFrustration(FrustrationType.ERROR)
      }

      const frustrationTypes: FrustrationType[] = []
      frustrations.forEach((frustration) => {
        frustrationTypes.push(frustration)
      })
      const { resourceCount, errorCount, longTaskCount } = eventCountsSubscription.eventCounts
      const action: AutoAction = assign(
        {
          duration: state.endTime && elapsed(base.startClocks.timeStamp, state.endTime),
          id,
          frustrationTypes,
          counts: {
            resourceCount,
            errorCount,
            longTaskCount,
          },
        },
        base
      )
      lifeCycle.notify(LifeCycleEventType.AUTO_ACTION_COMPLETED, action)
      state = { status: PotentialActionStatus.FINALIZED }
    },

    discard: () => {
      stop()
      state = { status: PotentialActionStatus.FINALIZED }
    },
  }
}
