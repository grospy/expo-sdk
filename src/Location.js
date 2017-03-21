// @flow

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import * as Permissions from './Permissions';
import invariant from 'invariant';

type LocationOptions = {
  enableHighAccuracy: ?boolean,
  timeInterval: ?number,
  distanceInterval: ?number,
};

type LocationData = {
  coords: {
    latitude: number,
    longitude: number,
    altitude: number,
    accuracy: number,
    heading: number,
    speed: number,
  },
  timestamp: number,
};

type LocationCallback = (data: LocationData) => any;

const { ExponentLocation } = NativeModules;
const LocationEventEmitter = new NativeEventEmitter(ExponentLocation);

let nextWatchId = 0;
let watchCallbacks: { [watchId: number]: LocationCallback } = {};
let deviceEventSubscription: ?Function;

export function getCurrentPositionAsync(options: LocationOptions) {
  // On Android we have a native method for this case.
  if (Platform.OS === 'android') {
    return ExponentLocation.getCurrentPositionAsync(options);
  }

  // On iOS we implement it in terms of `.watchPositionAsync(...)`
  // TODO: Use separate native method for iOS too?
  return new Promise(async (resolve, reject) => {
    try {
      let done = false; // To make sure we only resolve once.

      let subscription;
      subscription = await watchPositionAsync(options, location => {
        if (!done) {
          resolve(location);
          done = true;
        }
        subscription.remove();
      });

      // In case the callback is fired before we get here.
      if (done) {
        subscription.remove();
      }
    } catch (e) {
      reject(e);
    }
  });
}

function _maybeInitializeEmitterSubscription() {
  if (!deviceEventSubscription) {
    deviceEventSubscription = LocationEventEmitter.addListener(
      'Exponent.locationChanged',
      ({ watchId, location }) => {
        const callback = watchCallbacks[watchId];
        if (callback) {
          callback(location);
        } else {
          ExponentLocation.removeWatchAsync(watchId);
        }
      }
    );
  }
}

async function _askPermissionForWatchAsync(success, error, options, watchId) {
  // TODO: test what happens when permission hasn't been requested yet
  // what do we return here? do we just init the watchId and then
  // remove it?
  let { status } = await Permissions.askAsync(Permissions.LOCATION);
  if (status === 'granted') {
    ExponentLocation.watchPositionImplAsync(watchId, options);
  } else {
    _removeWatcher(watchId);
    error({ watchId, message: 'No permission to access location' });
  }
}

// Polyfill: navigator.geolocation.watchPosition
function watchPosition(
  success: GeoSuccessCallback,
  error: GeoErrorCallback,
  options: LocationOptions
) {
  _maybeInitializeEmitterSubscription();

  const watchId = nextWatchId++;
  watchCallbacks[watchId] = success;

  _askPermissionForWatchAsync(success, error, options, watchId);

  return watchId;
}

export async function watchPositionAsync(
  options: LocationOptions,
  callback: LocationCallback
) {
  _maybeInitializeEmitterSubscription();

  const watchId = nextWatchId++;
  watchCallbacks[watchId] = callback;
  await ExponentLocation.watchPositionImplAsync(watchId, options);

  return {
    remove() {
      _removeWatcher(watchId);
    },
  };
}

// Polyfill: navigator.geolocation.clearWatch
function clearWatch(watchId) {
  _removeWatcher(watchId);
}

function _removeWatcher(watchId) {
  // Do nothing if we have already removed the subscription
  if (!watchCallbacks[watchId]) {
    return;
  }

  ExponentLocation.removeWatchAsync(watchId);
  delete watchCallbacks[watchId];
  if (Object.keys(watchCallbacks).length === 0) {
    LocationEventEmitter.removeSubscription(deviceEventSubscription);
    deviceEventSubscription = null;
  }
}

type GeoSuccessCallback = (data: LocationData) => void;
type GeoErrorCallback = (error: any) => void;

function getCurrentPosition(
  success: GeoSuccessCallback,
  error: GeoErrorCallback,
  options: LocationOptions
): void {
  invariant(
    typeof success === 'function',
    'Must provide a valid success callback.'
  );
  _getCurrentPositionAsyncWrapper(success, error, options);
}

// This function exists to let us continue to return undefined from
// getCurrentPosition, while still using async/await for the internal
// implementation of it
async function _getCurrentPositionAsyncWrapper(
  success: GeoSuccessCallback,
  error: GeoErrorCallback,
  options: LocationOptions
): Promise<*> {
  try {
    let { status } = await Permissions.askAsync(Permissions.LOCATION);
    if (status !== 'granted') {
      throw new Error(
        'Permission to access location not granted. User must now enable it manually in settings'
      );
    }

    let result = await getCurrentPositionAsync(options);
    success(result);
  } catch (e) {
    error(e);
  }
}

// Polyfill navigator.geolocation for interop with the core react-native and
// web API approach to geolocation
window.navigator.geolocation = {
  getCurrentPosition,
  watchPosition,
  clearWatch,

  // We don't polyfill stopObserving, this is an internal method that probably
  // should not even exist in react-native docs
  stopObserving: () => {},
};
