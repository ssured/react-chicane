import { createBrowserHistory, createPath, parsePath } from "history";
import * as React from "react";
import { useSubscription } from "use-subscription";
import { first, useIsoLayoutEffect } from "./helpers";
import { decodeLocation } from "./location";
import { getMatcher, match, matchToHistoryPath } from "./matcher";
import {
  ExtractRoutesParams,
  GetNestedRoutes,
  Location,
  Matcher,
  ParamsArg,
  PrependBasePath,
  RedirectProps,
  Simplify,
  Subscription,
} from "./types";

export { decodeSearch, encodeSearch } from "./search";
export type { Location, Search } from "./types";

export const createRouter = <
  Routes extends Record<string, string>,
  BasePath extends string,
  RoutesWithBasePath extends PrependBasePath<Routes, BasePath>,
  NestedRoutes extends GetNestedRoutes<RoutesWithBasePath>,
  NestedRoutesParams extends ExtractRoutesParams<NestedRoutes>,
  FiniteRoutes extends Omit<RoutesWithBasePath, keyof NestedRoutes>,
  FiniteRoutesParams extends ExtractRoutesParams<FiniteRoutes>,
  RoutesParams extends NestedRoutesParams & FiniteRoutesParams,
>(
  routes: Readonly<Routes>,
  options: { basePath?: BasePath } = {},
) => {
  const { basePath = "" } = options;

  const matchers = {} as Record<keyof Routes, Matcher>;
  const rankedMatchers: Matcher[] = []; // higher to lower
  const subscriptions = new Set<Subscription>();

  for (const routeName in routes) {
    if (Object.prototype.hasOwnProperty.call(routes, routeName)) {
      const matcher = getMatcher(routeName, `${basePath}/${routes[routeName]}`);
      matchers[routeName] = matcher;
      rankedMatchers.push(matcher);
    }
  }

  rankedMatchers.sort(
    (matcherA, matcherB) => matcherB.ranking - matcherA.ranking,
  );

  const history = createBrowserHistory();
  let currentLocation = decodeLocation(history.location, true);

  if (currentLocation.url !== createPath(history.location)) {
    history.replace(currentLocation.url); // URL cleanup
  }

  history.listen(({ location }) => {
    currentLocation = decodeLocation(location, false);
    subscriptions.forEach((subscription) => subscription(currentLocation));
  });

  const subscribe = (subscription: Subscription): (() => void) => {
    subscriptions.add(subscription);

    return () => {
      subscriptions.delete(subscription);
    };
  };

  const Redirect = <RouteName extends keyof FiniteRoutes>(
    props: RedirectProps<RouteName, FiniteRoutesParams[RouteName]>,
  ): null => {
    useIsoLayoutEffect(() => {
      const { replace = false } = props;

      if (props.external) {
        const { href } = props;

        if (replace) {
          window.location.replace(href);
        } else {
          window.location.assign(href);
        }
      } else {
        const {
          // @ts-expect-error
          params,
          route,
        } = props;

        const to = matchToHistoryPath(matchers[route as keyof Routes], params);

        if (replace) {
          history.replace(to);
        } else {
          history.push(to);
        }
      }
    }, []);

    return null;
  };

  return {
    get location() {
      return currentLocation;
    },

    subscribe,

    goForward: (): void => history.forward(),
    goBack: (): void => history.back(),

    navigate: <RouteName extends keyof FiniteRoutes>(
      routeName: RouteName,
      ...args: ParamsArg<FiniteRoutesParams[RouteName]>
    ): void =>
      history.push(
        matchToHistoryPath(matchers[routeName as keyof Routes], first(args)),
      ),

    replace: <RouteName extends keyof FiniteRoutes>(
      routeName: RouteName,
      ...args: ParamsArg<FiniteRoutesParams[RouteName]>
    ): void =>
      history.replace(
        matchToHistoryPath(matchers[routeName as keyof Routes], first(args)),
      ),

    createURL: <RouteName extends keyof FiniteRoutes>(
      routeName: RouteName,
      ...args: ParamsArg<FiniteRoutesParams[RouteName]>
    ): string =>
      createPath(
        matchToHistoryPath(matchers[routeName as keyof Routes], first(args)),
      ),

    useLocation: (): Location =>
      useSubscription(
        React.useMemo(
          () => ({ getCurrentValue: () => currentLocation, subscribe }),
          [],
        ),
      ),

    useRoute: <RouteName extends keyof FiniteRoutes | keyof NestedRoutes>(
      routeNames: ReadonlyArray<RouteName>,
    ): RouteName extends string
      ?
          | { name: RouteName; params: Simplify<RoutesParams[RouteName]> }
          | undefined
      : never =>
      // JSON.stringify / JSON.parse trick is used to prevent
      // unnecessary re-renders, as params object is updated each time
      JSON.parse(
        useSubscription(
          React.useMemo(() => {
            const matchers = rankedMatchers.filter(({ name }) =>
              routeNames.includes(name as RouteName),
            );

            return {
              getCurrentValue: () =>
                JSON.stringify(match(currentLocation, matchers)),
              subscribe,
            };
          }, [JSON.stringify(routeNames)]),
        ),
      ),

    // Kudos to https://github.com/remix-run/react-router/pull/7998
    useLink: ({
      href,
      replace = false,
      target,
    }: {
      href: string;
      replace?: boolean | undefined;
      target?: React.HTMLAttributeAnchorTarget | undefined;
    }) => {
      const { active, historyLocation } = useSubscription(
        React.useMemo(
          () => ({
            getCurrentValue: () => {
              const {
                pathname = "/",
                search = "",
                hash = "",
              } = parsePath(href);

              return {
                active: href === currentLocation.url,
                historyLocation: { pathname, search, hash },
              };
            },
            subscribe,
          }),
          [href],
        ),
      );

      const shouldReplace = replace || active;
      const shouldIgnoreTarget = !target || target === "_self";

      return {
        active,
        onClick: React.useCallback(
          (event: React.MouseEvent) => {
            if (
              !event.defaultPrevented &&
              shouldIgnoreTarget && // Let browser handle "target=_blank" etc.
              event.button === 0 && // Ignore everything but left clicks
              !(
                event.metaKey ||
                event.altKey ||
                event.ctrlKey ||
                event.shiftKey
              ) // Ignore clicks with modifier keys
            ) {
              event.preventDefault();

              shouldReplace
                ? history.replace(historyLocation)
                : history.push(historyLocation);
            }
          },
          [shouldIgnoreTarget, shouldReplace, historyLocation],
        ),
      };
    },

    Redirect,
  };
};
