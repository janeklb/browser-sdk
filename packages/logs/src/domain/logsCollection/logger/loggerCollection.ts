import { includes, display, combine, ErrorSource, isExperimentalFeatureEnabled } from '@datadog/browser-core'
import type { CommonContext } from '../../../rawLogsEvent.types'
import type { LifeCycle } from '../../lifeCycle'
import { LifeCycleEventType } from '../../lifeCycle'
import type { Logger, LogsMessage } from '../../logger'
import { StatusType, HandlerType } from '../../logger'

export const STATUS_PRIORITIES: { [key in StatusType]: number } = {
  [StatusType.debug]: 0,
  [StatusType.info]: 1,
  [StatusType.warn]: 2,
  [StatusType.error]: 3,
}

export function startLoggerCollection(lifeCycle: LifeCycle) {
  function handleLog(logsMessage: LogsMessage, logger: Logger, savedCommonContext?: CommonContext) {
    const messageContext = logsMessage.context

    if (isAuthorized(logsMessage.status, HandlerType.console, logger)) {
      display.log(`${logsMessage.status}: ${logsMessage.message}`, combine(logger.getContext(), messageContext))
    }

    lifeCycle.notify(LifeCycleEventType.RAW_LOG_COLLECTED, {
      rawLogsEvent: {
        message: logsMessage.message,
        status: logsMessage.status,
        origin: isExperimentalFeatureEnabled('forward-logs') ? ErrorSource.LOGGER : undefined,
      },
      messageContext,
      savedCommonContext,
      logger,
    })
  }

  return {
    handleLog,
  }
}

export function isAuthorized(status: StatusType, handlerType: HandlerType, logger: Logger) {
  const loggerHandler = logger.getHandler()
  const sanitizedHandlerType = Array.isArray(loggerHandler) ? loggerHandler : [loggerHandler]
  return (
    STATUS_PRIORITIES[status] >= STATUS_PRIORITIES[logger.getLevel()] && includes(sanitizedHandlerType, handlerType)
  )
}
