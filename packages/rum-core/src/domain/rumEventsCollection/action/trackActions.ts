import type { Context, Duration, ClocksState, RelativeTime, TimeStamp, Subscription } from '@datadog/browser-core'
import {
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
import type { BaseClick, ClickChain, ClickReference } from './clickChain'
import { createClickChain } from './clickChain'
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
  duration: Duration
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

interface ActionClick extends BaseClick {
  singleClickPotentialAction: PotentialAction
}

interface TrackActionsState {
  readonly lifeCycle: LifeCycle
  readonly domMutationObservable: Observable<void>
  readonly actionNameAttribute: string | undefined
  readonly collectFrustrations: boolean
  readonly history: ContextHistory<string>
  readonly stopObservable: Observable<void>
  currentClickChain?: ClickChain<ActionClick>
}

export function trackActions(
  lifeCycle: LifeCycle,
  domMutationObservable: Observable<void>,
  { actionNameAttribute }: RumConfiguration
) {
  const state: TrackActionsState = {
    // TODO: this will be changed when we introduce a proper initialization parameter for it
    collectFrustrations: isExperimentalFeatureEnabled('frustration-signals'),
    lifeCycle,
    domMutationObservable,
    actionNameAttribute,
    history: new ContextHistory(ACTION_CONTEXT_TIME_OUT_DELAY),
    stopObservable: new Observable(),
  }

  lifeCycle.subscribe(LifeCycleEventType.SESSION_RENEWED, () => {
    state.history.reset()
  })

  const { stop: stopListener } = listenClickEvents((event) => {
    onClick(state, event)
  })

  const actionContexts: ActionContexts = {
    findActionId: (startTime?: RelativeTime) =>
      isExperimentalFeatureEnabled('frustration-signals')
        ? state.history.findAll(startTime)
        : state.history.find(startTime),
  }

  return {
    stop: () => {
      state.stopObservable.notify()
      stopListener()
    },
    actionContexts,
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

function onClick(state: TrackActionsState, event: MouseEvent & { target: Element }) {
  if (!state.collectFrustrations && state.history.find()) {
    // TODO: remove this in a future major version. To keep retrocompatibility, ignore any new
    // action if another one is already occurring.
    return
  }

  const name = getActionNameFromElement(event.target, state.actionNameAttribute)
  if (!state.collectFrustrations && !name) {
    // TODO: remove this in a future major version. To keep retrocompatibility, ignore any action
    // with a blank name
    return
  }

  const startClocks = clocksNow()

  const singleClickPotentialAction = newPotentialAction(state, {
    name,
    event,
    type: ActionType.CLICK as const,
    startClocks,
  })

  let onEndClick: () => void
  if (state.collectFrustrations) {
    // If we collect frustration, we have to use a "click chain", and delay the action notification
    // until we know that it's not part of a rage click
    const clickReference = addClickToClickChain(state, singleClickPotentialAction)
    onEndClick = clickReference.markAsComplete
  } else {
    // Else, just notify the action when on click end
    onEndClick = singleClickPotentialAction.notifyIfComplete
  }

  const { stop: stopWaitingIdlePage } = waitIdlePage(
    state.lifeCycle,
    state.domMutationObservable,
    (idleEvent) => {
      if (!idleEvent.hadActivity) {
        // If it has no activity, consider it as a dead click.
        // TODO: this will yield a lot of false positive. We'll need to refine it in the future.
        if (state.collectFrustrations) {
          singleClickPotentialAction.frustrations.add(FrustrationType.DEAD)
          singleClickPotentialAction.complete(startClocks.timeStamp)
        } else {
          singleClickPotentialAction.discard()
        }
      } else if (idleEvent.end < startClocks.timeStamp) {
        // If the clock is looking weird, just discard the action
        singleClickPotentialAction.discard()
      } else {
        // Else complete the action at the end of the page activity
        singleClickPotentialAction.complete(idleEvent.end)
      }
      endClick()
    },
    AUTO_ACTION_MAX_DURATION
  )

  let viewCreatedSubscription: Subscription | undefined
  if (!state.collectFrustrations) {
    // TODO: remove this in a future major version. To keep retrocompatibility, end the action on a
    // new view is created.
    viewCreatedSubscription = state.lifeCycle.subscribe(LifeCycleEventType.VIEW_CREATED, endClick)
  }

  const stopSubscription = state.stopObservable.subscribe(endClick)

  function endClick() {
    onEndClick()

    // Cleanup any ongoing process
    singleClickPotentialAction.discard()
    if (viewCreatedSubscription) {
      viewCreatedSubscription.unsubscribe()
    }
    stopWaitingIdlePage()
    stopSubscription.unsubscribe()
  }
}

type PotentialAction = ReturnType<typeof newPotentialAction>
function newPotentialAction(
  { lifeCycle, history, collectFrustrations }: TrackActionsState,
  base: Pick<AutoAction, 'startClocks' | 'event' | 'name' | 'type'>
) {
  const id = generateUUID()
  const historyEntry = history.add(id, base.startClocks.relative)
  const eventCountsSubscription = trackEventCounts(lifeCycle)
  let finalState: { isDiscarded: false; endTime: TimeStamp } | { isDiscarded: true } | undefined
  const frustrations = new Set<FrustrationType>()

  return {
    base,
    frustrations,

    complete: (endTime: TimeStamp) => {
      if (finalState) {
        return
      }
      finalState = { isDiscarded: false, endTime }
      historyEntry.close(getRelativeTime(endTime))
      eventCountsSubscription.stop()
      if (eventCountsSubscription.eventCounts.errorCount > 0) {
        frustrations.add(FrustrationType.ERROR)
      }
    },

    discard: () => {
      if (finalState) {
        return
      }
      finalState = { isDiscarded: true }
      historyEntry.remove()
      eventCountsSubscription.stop()
    },

    notifyIfComplete: () => {
      if (!finalState || finalState.isDiscarded) {
        return
      }

      const frustrationTypes: FrustrationType[] = []
      if (collectFrustrations) {
        frustrations.forEach((frustration) => {
          frustrationTypes.push(frustration)
        })
      }
      const { resourceCount, errorCount, longTaskCount } = eventCountsSubscription.eventCounts
      const action: AutoAction = assign(
        {
          duration: elapsed(base.startClocks.timeStamp, finalState.endTime),
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
    },
  }
}

function addClickToClickChain(state: TrackActionsState, singleClickPotentialAction: PotentialAction): ClickReference {
  const click: ActionClick = {
    event: singleClickPotentialAction.base.event,
    timeStamp: singleClickPotentialAction.base.startClocks.timeStamp,
    singleClickPotentialAction,
  }
  let clickReference = state.currentClickChain && state.currentClickChain.tryAppend(click)
  // If we failed to add the click to the current click chain, create a new click chain
  if (!clickReference) {
    const newClickChain = createClickChain<ActionClick>((clicks) => {
      flushClickChain(clicks)
      stopSubscription.unsubscribe()
    })
    const stopSubscription = state.stopObservable.subscribe(newClickChain.stop)
    // adding a click to a newly created click chain should always succeed
    clickReference = newClickChain.tryAppend(click)!
    state.currentClickChain = newClickChain
  }
  return clickReference
}

function flushClickChain(clicks: ActionClick[]) {
  // Send an action for each individual click
  clicks.forEach((click) => click.singleClickPotentialAction.notifyIfComplete())
}
