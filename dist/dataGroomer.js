"format register";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function dedupe(deps) {
    var newDeps = [];
    for (var i = 0, l = deps.length; i < l; i++)
      if (indexOf.call(newDeps, deps[i]) == -1)
        newDeps.push(deps[i])
    return newDeps;
  }

  function register(name, deps, declare, execute) {
    if (typeof name != 'string')
      throw "System.register provided no module name";
    
    var entry;

    // dynamic
    if (typeof declare == 'boolean') {
      entry = {
        declarative: false,
        deps: deps,
        execute: execute,
        executingRequire: declare
      };
    }
    else {
      // ES6 declarative
      if (deps.length > 0 && declare.length != 1)
        throw 'Invalid System.register form for ' + name + '. Declare function must take one argument.';
      entry = {
        declarative: true,
        deps: deps,
        declare: declare
      };
    }

    entry.name = name;
    
    // we never overwrite an existing define
    if (!defined[name])
      defined[name] = entry; 

    entry.deps = dedupe(entry.deps);

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }

  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      
      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;
      
      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {
        
        // if already in a group, remove from the old group
        if (depEntry.groupIndex) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;
      exports[name] = value;

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          var importerIndex = indexOf.call(importerModule.dependencies, module);
          importerModule.setters[importerIndex](exports);
        }
      }

      module.locked = false;
      return value;
    });
    
    module.setters = declaration.setters;
    module.execute = declaration.execute;

    if (!module.setters || !module.execute)
      throw "Invalid System.register form for " + entry.name;

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = { 'default': depEntry.module.exports, __useDefault: true };
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw "System Register: The module requested " + name + " but this was not declared as a dependency";
      if (exports.__useDefault)
        exports = exports['default'];
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);
    
      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }
    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
    }, exports, module);
    
    if (output)
      module.exports = output;
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    var module = entry.declarative ? entry.module.exports : { 'default': entry.module.exports, '__useDefault': true };
    entry.module.module = module;

    // return the defined module object
    return modules[name] = module;
  };

  return function(main, declare) {

    // if there's a system loader, define onto it
    if (typeof System != 'undefined' && System.register) {
      declare(System);
      System['import'](main);
    }
    // otherwise, self execute
    else {
      declare(System = {
        register: register, 
        get: load, 
        set: function(name, module) {
          modules[name] = module; 
        },
        newModule: function(module) {
          return module;
        },
        global: global 
      });
      load(main);
    }
  };

})(typeof window != 'undefined' ? window : global)
/* ('mainModule', function(System) {
  System.register(...);
}); */
('build/src/dataGroomer', function(System) {




System.register("github:reactjs/react-bower@0.11.2/react", [], false, function(__require, __exports, __module) {
  System.get("@@global-helpers").prepareGlobal(__module.id, []);
  (function() {  /* */ 
      "format global";
      /**
       * React v0.11.2
       */
      !function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.React=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule AutoFocusMixin
       * @typechecks static-only
       */
      
      "use strict";
      
      var focusNode = _dereq_("./focusNode");
      
      var AutoFocusMixin = {
        componentDidMount: function() {
          if (this.props.autoFocus) {
            focusNode(this.getDOMNode());
          }
        }
      };
      
      module.exports = AutoFocusMixin;
      
      },{"./focusNode":106}],2:[function(_dereq_,module,exports){
      /**
       * Copyright 2013 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule BeforeInputEventPlugin
       * @typechecks static-only
       */
      
      "use strict";
      
      var EventConstants = _dereq_("./EventConstants");
      var EventPropagators = _dereq_("./EventPropagators");
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      var SyntheticInputEvent = _dereq_("./SyntheticInputEvent");
      
      var keyOf = _dereq_("./keyOf");
      
      var canUseTextInputEvent = (
        ExecutionEnvironment.canUseDOM &&
        'TextEvent' in window &&
        !('documentMode' in document || isPresto())
      );
      
      /**
       * Opera <= 12 includes TextEvent in window, but does not fire
       * text input events. Rely on keypress instead.
       */
      function isPresto() {
        var opera = window.opera;
        return (
          typeof opera === 'object' &&
          typeof opera.version === 'function' &&
          parseInt(opera.version(), 10) <= 12
        );
      }
      
      var SPACEBAR_CODE = 32;
      var SPACEBAR_CHAR = String.fromCharCode(SPACEBAR_CODE);
      
      var topLevelTypes = EventConstants.topLevelTypes;
      
      // Events and their corresponding property names.
      var eventTypes = {
        beforeInput: {
          phasedRegistrationNames: {
            bubbled: keyOf({onBeforeInput: null}),
            captured: keyOf({onBeforeInputCapture: null})
          },
          dependencies: [
            topLevelTypes.topCompositionEnd,
            topLevelTypes.topKeyPress,
            topLevelTypes.topTextInput,
            topLevelTypes.topPaste
          ]
        }
      };
      
      // Track characters inserted via keypress and composition events.
      var fallbackChars = null;
      
      /**
       * Return whether a native keypress event is assumed to be a command.
       * This is required because Firefox fires `keypress` events for key commands
       * (cut, copy, select-all, etc.) even though no character is inserted.
       */
      function isKeypressCommand(nativeEvent) {
        return (
          (nativeEvent.ctrlKey || nativeEvent.altKey || nativeEvent.metaKey) &&
          // ctrlKey && altKey is equivalent to AltGr, and is not a command.
          !(nativeEvent.ctrlKey && nativeEvent.altKey)
        );
      }
      
      /**
       * Create an `onBeforeInput` event to match
       * http://www.w3.org/TR/2013/WD-DOM-Level-3-Events-20131105/#events-inputevents.
       *
       * This event plugin is based on the native `textInput` event
       * available in Chrome, Safari, Opera, and IE. This event fires after
       * `onKeyPress` and `onCompositionEnd`, but before `onInput`.
       *
       * `beforeInput` is spec'd but not implemented in any browsers, and
       * the `input` event does not provide any useful information about what has
       * actually been added, contrary to the spec. Thus, `textInput` is the best
       * available event to identify the characters that have actually been inserted
       * into the target node.
       */
      var BeforeInputEventPlugin = {
      
        eventTypes: eventTypes,
      
        /**
         * @param {string} topLevelType Record from `EventConstants`.
         * @param {DOMEventTarget} topLevelTarget The listening component root node.
         * @param {string} topLevelTargetID ID of `topLevelTarget`.
         * @param {object} nativeEvent Native browser event.
         * @return {*} An accumulation of synthetic events.
         * @see {EventPluginHub.extractEvents}
         */
        extractEvents: function(
            topLevelType,
            topLevelTarget,
            topLevelTargetID,
            nativeEvent) {
      
          var chars;
      
          if (canUseTextInputEvent) {
            switch (topLevelType) {
              case topLevelTypes.topKeyPress:
                /**
                 * If native `textInput` events are available, our goal is to make
                 * use of them. However, there is a special case: the spacebar key.
                 * In Webkit, preventing default on a spacebar `textInput` event
                 * cancels character insertion, but it *also* causes the browser
                 * to fall back to its default spacebar behavior of scrolling the
                 * page.
                 *
                 * Tracking at:
                 * https://code.google.com/p/chromium/issues/detail?id=355103
                 *
                 * To avoid this issue, use the keypress event as if no `textInput`
                 * event is available.
                 */
                var which = nativeEvent.which;
                if (which !== SPACEBAR_CODE) {
                  return;
                }
      
                chars = String.fromCharCode(which);
                break;
      
              case topLevelTypes.topTextInput:
                // Record the characters to be added to the DOM.
                chars = nativeEvent.data;
      
                // If it's a spacebar character, assume that we have already handled
                // it at the keypress level and bail immediately.
                if (chars === SPACEBAR_CHAR) {
                  return;
                }
      
                // Otherwise, carry on.
                break;
      
              default:
                // For other native event types, do nothing.
                return;
            }
          } else {
            switch (topLevelType) {
              case topLevelTypes.topPaste:
                // If a paste event occurs after a keypress, throw out the input
                // chars. Paste events should not lead to BeforeInput events.
                fallbackChars = null;
                break;
              case topLevelTypes.topKeyPress:
                /**
                 * As of v27, Firefox may fire keypress events even when no character
                 * will be inserted. A few possibilities:
                 *
                 * - `which` is `0`. Arrow keys, Esc key, etc.
                 *
                 * - `which` is the pressed key code, but no char is available.
                 *   Ex: 'AltGr + d` in Polish. There is no modified character for
                 *   this key combination and no character is inserted into the
                 *   document, but FF fires the keypress for char code `100` anyway.
                 *   No `input` event will occur.
                 *
                 * - `which` is the pressed key code, but a command combination is
                 *   being used. Ex: `Cmd+C`. No character is inserted, and no
                 *   `input` event will occur.
                 */
                if (nativeEvent.which && !isKeypressCommand(nativeEvent)) {
                  fallbackChars = String.fromCharCode(nativeEvent.which);
                }
                break;
              case topLevelTypes.topCompositionEnd:
                fallbackChars = nativeEvent.data;
                break;
            }
      
            // If no changes have occurred to the fallback string, no relevant
            // event has fired and we're done.
            if (fallbackChars === null) {
              return;
            }
      
            chars = fallbackChars;
          }
      
          // If no characters are being inserted, no BeforeInput event should
          // be fired.
          if (!chars) {
            return;
          }
      
          var event = SyntheticInputEvent.getPooled(
            eventTypes.beforeInput,
            topLevelTargetID,
            nativeEvent
          );
      
          event.data = chars;
          fallbackChars = null;
          EventPropagators.accumulateTwoPhaseDispatches(event);
          return event;
        }
      };
      
      module.exports = BeforeInputEventPlugin;
      
      },{"./EventConstants":15,"./EventPropagators":20,"./ExecutionEnvironment":21,"./SyntheticInputEvent":86,"./keyOf":127}],3:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule CSSProperty
       */
      
      "use strict";
      
      /**
       * CSS properties which accept numbers but are not in units of "px".
       */
      var isUnitlessNumber = {
        columnCount: true,
        fillOpacity: true,
        flex: true,
        flexGrow: true,
        flexShrink: true,
        fontWeight: true,
        lineClamp: true,
        lineHeight: true,
        opacity: true,
        order: true,
        orphans: true,
        widows: true,
        zIndex: true,
        zoom: true
      };
      
      /**
       * @param {string} prefix vendor-specific prefix, eg: Webkit
       * @param {string} key style name, eg: transitionDuration
       * @return {string} style name prefixed with `prefix`, properly camelCased, eg:
       * WebkitTransitionDuration
       */
      function prefixKey(prefix, key) {
        return prefix + key.charAt(0).toUpperCase() + key.substring(1);
      }
      
      /**
       * Support style names that may come passed in prefixed by adding permutations
       * of vendor prefixes.
       */
      var prefixes = ['Webkit', 'ms', 'Moz', 'O'];
      
      // Using Object.keys here, or else the vanilla for-in loop makes IE8 go into an
      // infinite loop, because it iterates over the newly added props too.
      Object.keys(isUnitlessNumber).forEach(function(prop) {
        prefixes.forEach(function(prefix) {
          isUnitlessNumber[prefixKey(prefix, prop)] = isUnitlessNumber[prop];
        });
      });
      
      /**
       * Most style properties can be unset by doing .style[prop] = '' but IE8
       * doesn't like doing that with shorthand properties so for the properties that
       * IE8 breaks on, which are listed here, we instead unset each of the
       * individual properties. See http://bugs.jquery.com/ticket/12385.
       * The 4-value 'clock' properties like margin, padding, border-width seem to
       * behave without any problems. Curiously, list-style works too without any
       * special prodding.
       */
      var shorthandPropertyExpansions = {
        background: {
          backgroundImage: true,
          backgroundPosition: true,
          backgroundRepeat: true,
          backgroundColor: true
        },
        border: {
          borderWidth: true,
          borderStyle: true,
          borderColor: true
        },
        borderBottom: {
          borderBottomWidth: true,
          borderBottomStyle: true,
          borderBottomColor: true
        },
        borderLeft: {
          borderLeftWidth: true,
          borderLeftStyle: true,
          borderLeftColor: true
        },
        borderRight: {
          borderRightWidth: true,
          borderRightStyle: true,
          borderRightColor: true
        },
        borderTop: {
          borderTopWidth: true,
          borderTopStyle: true,
          borderTopColor: true
        },
        font: {
          fontStyle: true,
          fontVariant: true,
          fontWeight: true,
          fontSize: true,
          lineHeight: true,
          fontFamily: true
        }
      };
      
      var CSSProperty = {
        isUnitlessNumber: isUnitlessNumber,
        shorthandPropertyExpansions: shorthandPropertyExpansions
      };
      
      module.exports = CSSProperty;
      
      },{}],4:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule CSSPropertyOperations
       * @typechecks static-only
       */
      
      "use strict";
      
      var CSSProperty = _dereq_("./CSSProperty");
      
      var dangerousStyleValue = _dereq_("./dangerousStyleValue");
      var hyphenateStyleName = _dereq_("./hyphenateStyleName");
      var memoizeStringOnly = _dereq_("./memoizeStringOnly");
      
      var processStyleName = memoizeStringOnly(function(styleName) {
        return hyphenateStyleName(styleName);
      });
      
      /**
       * Operations for dealing with CSS properties.
       */
      var CSSPropertyOperations = {
      
        /**
         * Serializes a mapping of style properties for use as inline styles:
         *
         *   > createMarkupForStyles({width: '200px', height: 0})
         *   "width:200px;height:0;"
         *
         * Undefined values are ignored so that declarative programming is easier.
         * The result should be HTML-escaped before insertion into the DOM.
         *
         * @param {object} styles
         * @return {?string}
         */
        createMarkupForStyles: function(styles) {
          var serialized = '';
          for (var styleName in styles) {
            if (!styles.hasOwnProperty(styleName)) {
              continue;
            }
            var styleValue = styles[styleName];
            if (styleValue != null) {
              serialized += processStyleName(styleName) + ':';
              serialized += dangerousStyleValue(styleName, styleValue) + ';';
            }
          }
          return serialized || null;
        },
      
        /**
         * Sets the value for multiple styles on a node.  If a value is specified as
         * '' (empty string), the corresponding style property will be unset.
         *
         * @param {DOMElement} node
         * @param {object} styles
         */
        setValueForStyles: function(node, styles) {
          var style = node.style;
          for (var styleName in styles) {
            if (!styles.hasOwnProperty(styleName)) {
              continue;
            }
            var styleValue = dangerousStyleValue(styleName, styles[styleName]);
            if (styleValue) {
              style[styleName] = styleValue;
            } else {
              var expansion = CSSProperty.shorthandPropertyExpansions[styleName];
              if (expansion) {
                // Shorthand property that IE8 won't like unsetting, so unset each
                // component to placate it
                for (var individualStyleName in expansion) {
                  style[individualStyleName] = '';
                }
              } else {
                style[styleName] = '';
              }
            }
          }
        }
      
      };
      
      module.exports = CSSPropertyOperations;
      
      },{"./CSSProperty":3,"./dangerousStyleValue":101,"./hyphenateStyleName":118,"./memoizeStringOnly":129}],5:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule CallbackQueue
       */
      
      "use strict";
      
      var PooledClass = _dereq_("./PooledClass");
      
      var invariant = _dereq_("./invariant");
      var mixInto = _dereq_("./mixInto");
      
      /**
       * A specialized pseudo-event module to help keep track of components waiting to
       * be notified when their DOM representations are available for use.
       *
       * This implements `PooledClass`, so you should never need to instantiate this.
       * Instead, use `CallbackQueue.getPooled()`.
       *
       * @class ReactMountReady
       * @implements PooledClass
       * @internal
       */
      function CallbackQueue() {
        this._callbacks = null;
        this._contexts = null;
      }
      
      mixInto(CallbackQueue, {
      
        /**
         * Enqueues a callback to be invoked when `notifyAll` is invoked.
         *
         * @param {function} callback Invoked when `notifyAll` is invoked.
         * @param {?object} context Context to call `callback` with.
         * @internal
         */
        enqueue: function(callback, context) {
          this._callbacks = this._callbacks || [];
          this._contexts = this._contexts || [];
          this._callbacks.push(callback);
          this._contexts.push(context);
        },
      
        /**
         * Invokes all enqueued callbacks and clears the queue. This is invoked after
         * the DOM representation of a component has been created or updated.
         *
         * @internal
         */
        notifyAll: function() {
          var callbacks = this._callbacks;
          var contexts = this._contexts;
          if (callbacks) {
            ("production" !== "development" ? invariant(
              callbacks.length === contexts.length,
              "Mismatched list of contexts in callback queue"
            ) : invariant(callbacks.length === contexts.length));
            this._callbacks = null;
            this._contexts = null;
            for (var i = 0, l = callbacks.length; i < l; i++) {
              callbacks[i].call(contexts[i]);
            }
            callbacks.length = 0;
            contexts.length = 0;
          }
        },
      
        /**
         * Resets the internal queue.
         *
         * @internal
         */
        reset: function() {
          this._callbacks = null;
          this._contexts = null;
        },
      
        /**
         * `PooledClass` looks for this.
         */
        destructor: function() {
          this.reset();
        }
      
      });
      
      PooledClass.addPoolingTo(CallbackQueue);
      
      module.exports = CallbackQueue;
      
      },{"./PooledClass":26,"./invariant":120,"./mixInto":133}],6:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ChangeEventPlugin
       */
      
      "use strict";
      
      var EventConstants = _dereq_("./EventConstants");
      var EventPluginHub = _dereq_("./EventPluginHub");
      var EventPropagators = _dereq_("./EventPropagators");
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      var ReactUpdates = _dereq_("./ReactUpdates");
      var SyntheticEvent = _dereq_("./SyntheticEvent");
      
      var isEventSupported = _dereq_("./isEventSupported");
      var isTextInputElement = _dereq_("./isTextInputElement");
      var keyOf = _dereq_("./keyOf");
      
      var topLevelTypes = EventConstants.topLevelTypes;
      
      var eventTypes = {
        change: {
          phasedRegistrationNames: {
            bubbled: keyOf({onChange: null}),
            captured: keyOf({onChangeCapture: null})
          },
          dependencies: [
            topLevelTypes.topBlur,
            topLevelTypes.topChange,
            topLevelTypes.topClick,
            topLevelTypes.topFocus,
            topLevelTypes.topInput,
            topLevelTypes.topKeyDown,
            topLevelTypes.topKeyUp,
            topLevelTypes.topSelectionChange
          ]
        }
      };
      
      /**
       * For IE shims
       */
      var activeElement = null;
      var activeElementID = null;
      var activeElementValue = null;
      var activeElementValueProp = null;
      
      /**
       * SECTION: handle `change` event
       */
      function shouldUseChangeEvent(elem) {
        return (
          elem.nodeName === 'SELECT' ||
          (elem.nodeName === 'INPUT' && elem.type === 'file')
        );
      }
      
      var doesChangeEventBubble = false;
      if (ExecutionEnvironment.canUseDOM) {
        // See `handleChange` comment below
        doesChangeEventBubble = isEventSupported('change') && (
          !('documentMode' in document) || document.documentMode > 8
        );
      }
      
      function manualDispatchChangeEvent(nativeEvent) {
        var event = SyntheticEvent.getPooled(
          eventTypes.change,
          activeElementID,
          nativeEvent
        );
        EventPropagators.accumulateTwoPhaseDispatches(event);
      
        // If change and propertychange bubbled, we'd just bind to it like all the
        // other events and have it go through ReactBrowserEventEmitter. Since it
        // doesn't, we manually listen for the events and so we have to enqueue and
        // process the abstract event manually.
        //
        // Batching is necessary here in order to ensure that all event handlers run
        // before the next rerender (including event handlers attached to ancestor
        // elements instead of directly on the input). Without this, controlled
        // components don't work properly in conjunction with event bubbling because
        // the component is rerendered and the value reverted before all the event
        // handlers can run. See https://github.com/facebook/react/issues/708.
        ReactUpdates.batchedUpdates(runEventInBatch, event);
      }
      
      function runEventInBatch(event) {
        EventPluginHub.enqueueEvents(event);
        EventPluginHub.processEventQueue();
      }
      
      function startWatchingForChangeEventIE8(target, targetID) {
        activeElement = target;
        activeElementID = targetID;
        activeElement.attachEvent('onchange', manualDispatchChangeEvent);
      }
      
      function stopWatchingForChangeEventIE8() {
        if (!activeElement) {
          return;
        }
        activeElement.detachEvent('onchange', manualDispatchChangeEvent);
        activeElement = null;
        activeElementID = null;
      }
      
      function getTargetIDForChangeEvent(
          topLevelType,
          topLevelTarget,
          topLevelTargetID) {
        if (topLevelType === topLevelTypes.topChange) {
          return topLevelTargetID;
        }
      }
      function handleEventsForChangeEventIE8(
          topLevelType,
          topLevelTarget,
          topLevelTargetID) {
        if (topLevelType === topLevelTypes.topFocus) {
          // stopWatching() should be a noop here but we call it just in case we
          // missed a blur event somehow.
          stopWatchingForChangeEventIE8();
          startWatchingForChangeEventIE8(topLevelTarget, topLevelTargetID);
        } else if (topLevelType === topLevelTypes.topBlur) {
          stopWatchingForChangeEventIE8();
        }
      }
      
      
      /**
       * SECTION: handle `input` event
       */
      var isInputEventSupported = false;
      if (ExecutionEnvironment.canUseDOM) {
        // IE9 claims to support the input event but fails to trigger it when
        // deleting text, so we ignore its input events
        isInputEventSupported = isEventSupported('input') && (
          !('documentMode' in document) || document.documentMode > 9
        );
      }
      
      /**
       * (For old IE.) Replacement getter/setter for the `value` property that gets
       * set on the active element.
       */
      var newValueProp =  {
        get: function() {
          return activeElementValueProp.get.call(this);
        },
        set: function(val) {
          // Cast to a string so we can do equality checks.
          activeElementValue = '' + val;
          activeElementValueProp.set.call(this, val);
        }
      };
      
      /**
       * (For old IE.) Starts tracking propertychange events on the passed-in element
       * and override the value property so that we can distinguish user events from
       * value changes in JS.
       */
      function startWatchingForValueChange(target, targetID) {
        activeElement = target;
        activeElementID = targetID;
        activeElementValue = target.value;
        activeElementValueProp = Object.getOwnPropertyDescriptor(
          target.constructor.prototype,
          'value'
        );
      
        Object.defineProperty(activeElement, 'value', newValueProp);
        activeElement.attachEvent('onpropertychange', handlePropertyChange);
      }
      
      /**
       * (For old IE.) Removes the event listeners from the currently-tracked element,
       * if any exists.
       */
      function stopWatchingForValueChange() {
        if (!activeElement) {
          return;
        }
      
        // delete restores the original property definition
        delete activeElement.value;
        activeElement.detachEvent('onpropertychange', handlePropertyChange);
      
        activeElement = null;
        activeElementID = null;
        activeElementValue = null;
        activeElementValueProp = null;
      }
      
      /**
       * (For old IE.) Handles a propertychange event, sending a `change` event if
       * the value of the active element has changed.
       */
      function handlePropertyChange(nativeEvent) {
        if (nativeEvent.propertyName !== 'value') {
          return;
        }
        var value = nativeEvent.srcElement.value;
        if (value === activeElementValue) {
          return;
        }
        activeElementValue = value;
      
        manualDispatchChangeEvent(nativeEvent);
      }
      
      /**
       * If a `change` event should be fired, returns the target's ID.
       */
      function getTargetIDForInputEvent(
          topLevelType,
          topLevelTarget,
          topLevelTargetID) {
        if (topLevelType === topLevelTypes.topInput) {
          // In modern browsers (i.e., not IE8 or IE9), the input event is exactly
          // what we want so fall through here and trigger an abstract event
          return topLevelTargetID;
        }
      }
      
      // For IE8 and IE9.
      function handleEventsForInputEventIE(
          topLevelType,
          topLevelTarget,
          topLevelTargetID) {
        if (topLevelType === topLevelTypes.topFocus) {
          // In IE8, we can capture almost all .value changes by adding a
          // propertychange handler and looking for events with propertyName
          // equal to 'value'
          // In IE9, propertychange fires for most input events but is buggy and
          // doesn't fire when text is deleted, but conveniently, selectionchange
          // appears to fire in all of the remaining cases so we catch those and
          // forward the event if the value has changed
          // In either case, we don't want to call the event handler if the value
          // is changed from JS so we redefine a setter for `.value` that updates
          // our activeElementValue variable, allowing us to ignore those changes
          //
          // stopWatching() should be a noop here but we call it just in case we
          // missed a blur event somehow.
          stopWatchingForValueChange();
          startWatchingForValueChange(topLevelTarget, topLevelTargetID);
        } else if (topLevelType === topLevelTypes.topBlur) {
          stopWatchingForValueChange();
        }
      }
      
      // For IE8 and IE9.
      function getTargetIDForInputEventIE(
          topLevelType,
          topLevelTarget,
          topLevelTargetID) {
        if (topLevelType === topLevelTypes.topSelectionChange ||
            topLevelType === topLevelTypes.topKeyUp ||
            topLevelType === topLevelTypes.topKeyDown) {
          // On the selectionchange event, the target is just document which isn't
          // helpful for us so just check activeElement instead.
          //
          // 99% of the time, keydown and keyup aren't necessary. IE8 fails to fire
          // propertychange on the first input event after setting `value` from a
          // script and fires only keydown, keypress, keyup. Catching keyup usually
          // gets it and catching keydown lets us fire an event for the first
          // keystroke if user does a key repeat (it'll be a little delayed: right
          // before the second keystroke). Other input methods (e.g., paste) seem to
          // fire selectionchange normally.
          if (activeElement && activeElement.value !== activeElementValue) {
            activeElementValue = activeElement.value;
            return activeElementID;
          }
        }
      }
      
      
      /**
       * SECTION: handle `click` event
       */
      function shouldUseClickEvent(elem) {
        // Use the `click` event to detect changes to checkbox and radio inputs.
        // This approach works across all browsers, whereas `change` does not fire
        // until `blur` in IE8.
        return (
          elem.nodeName === 'INPUT' &&
          (elem.type === 'checkbox' || elem.type === 'radio')
        );
      }
      
      function getTargetIDForClickEvent(
          topLevelType,
          topLevelTarget,
          topLevelTargetID) {
        if (topLevelType === topLevelTypes.topClick) {
          return topLevelTargetID;
        }
      }
      
      /**
       * This plugin creates an `onChange` event that normalizes change events
       * across form elements. This event fires at a time when it's possible to
       * change the element's value without seeing a flicker.
       *
       * Supported elements are:
       * - input (see `isTextInputElement`)
       * - textarea
       * - select
       */
      var ChangeEventPlugin = {
      
        eventTypes: eventTypes,
      
        /**
         * @param {string} topLevelType Record from `EventConstants`.
         * @param {DOMEventTarget} topLevelTarget The listening component root node.
         * @param {string} topLevelTargetID ID of `topLevelTarget`.
         * @param {object} nativeEvent Native browser event.
         * @return {*} An accumulation of synthetic events.
         * @see {EventPluginHub.extractEvents}
         */
        extractEvents: function(
            topLevelType,
            topLevelTarget,
            topLevelTargetID,
            nativeEvent) {
      
          var getTargetIDFunc, handleEventFunc;
          if (shouldUseChangeEvent(topLevelTarget)) {
            if (doesChangeEventBubble) {
              getTargetIDFunc = getTargetIDForChangeEvent;
            } else {
              handleEventFunc = handleEventsForChangeEventIE8;
            }
          } else if (isTextInputElement(topLevelTarget)) {
            if (isInputEventSupported) {
              getTargetIDFunc = getTargetIDForInputEvent;
            } else {
              getTargetIDFunc = getTargetIDForInputEventIE;
              handleEventFunc = handleEventsForInputEventIE;
            }
          } else if (shouldUseClickEvent(topLevelTarget)) {
            getTargetIDFunc = getTargetIDForClickEvent;
          }
      
          if (getTargetIDFunc) {
            var targetID = getTargetIDFunc(
              topLevelType,
              topLevelTarget,
              topLevelTargetID
            );
            if (targetID) {
              var event = SyntheticEvent.getPooled(
                eventTypes.change,
                targetID,
                nativeEvent
              );
              EventPropagators.accumulateTwoPhaseDispatches(event);
              return event;
            }
          }
      
          if (handleEventFunc) {
            handleEventFunc(
              topLevelType,
              topLevelTarget,
              topLevelTargetID
            );
          }
        }
      
      };
      
      module.exports = ChangeEventPlugin;
      
      },{"./EventConstants":15,"./EventPluginHub":17,"./EventPropagators":20,"./ExecutionEnvironment":21,"./ReactUpdates":76,"./SyntheticEvent":84,"./isEventSupported":121,"./isTextInputElement":123,"./keyOf":127}],7:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ClientReactRootIndex
       * @typechecks
       */
      
      "use strict";
      
      var nextReactRootIndex = 0;
      
      var ClientReactRootIndex = {
        createReactRootIndex: function() {
          return nextReactRootIndex++;
        }
      };
      
      module.exports = ClientReactRootIndex;
      
      },{}],8:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule CompositionEventPlugin
       * @typechecks static-only
       */
      
      "use strict";
      
      var EventConstants = _dereq_("./EventConstants");
      var EventPropagators = _dereq_("./EventPropagators");
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      var ReactInputSelection = _dereq_("./ReactInputSelection");
      var SyntheticCompositionEvent = _dereq_("./SyntheticCompositionEvent");
      
      var getTextContentAccessor = _dereq_("./getTextContentAccessor");
      var keyOf = _dereq_("./keyOf");
      
      var END_KEYCODES = [9, 13, 27, 32]; // Tab, Return, Esc, Space
      var START_KEYCODE = 229;
      
      var useCompositionEvent = (
        ExecutionEnvironment.canUseDOM &&
        'CompositionEvent' in window
      );
      
      // In IE9+, we have access to composition events, but the data supplied
      // by the native compositionend event may be incorrect. In Korean, for example,
      // the compositionend event contains only one character regardless of
      // how many characters have been composed since compositionstart.
      // We therefore use the fallback data while still using the native
      // events as triggers.
      var useFallbackData = (
        !useCompositionEvent ||
        (
          'documentMode' in document &&
          document.documentMode > 8 &&
          document.documentMode <= 11
        )
      );
      
      var topLevelTypes = EventConstants.topLevelTypes;
      var currentComposition = null;
      
      // Events and their corresponding property names.
      var eventTypes = {
        compositionEnd: {
          phasedRegistrationNames: {
            bubbled: keyOf({onCompositionEnd: null}),
            captured: keyOf({onCompositionEndCapture: null})
          },
          dependencies: [
            topLevelTypes.topBlur,
            topLevelTypes.topCompositionEnd,
            topLevelTypes.topKeyDown,
            topLevelTypes.topKeyPress,
            topLevelTypes.topKeyUp,
            topLevelTypes.topMouseDown
          ]
        },
        compositionStart: {
          phasedRegistrationNames: {
            bubbled: keyOf({onCompositionStart: null}),
            captured: keyOf({onCompositionStartCapture: null})
          },
          dependencies: [
            topLevelTypes.topBlur,
            topLevelTypes.topCompositionStart,
            topLevelTypes.topKeyDown,
            topLevelTypes.topKeyPress,
            topLevelTypes.topKeyUp,
            topLevelTypes.topMouseDown
          ]
        },
        compositionUpdate: {
          phasedRegistrationNames: {
            bubbled: keyOf({onCompositionUpdate: null}),
            captured: keyOf({onCompositionUpdateCapture: null})
          },
          dependencies: [
            topLevelTypes.topBlur,
            topLevelTypes.topCompositionUpdate,
            topLevelTypes.topKeyDown,
            topLevelTypes.topKeyPress,
            topLevelTypes.topKeyUp,
            topLevelTypes.topMouseDown
          ]
        }
      };
      
      /**
       * Translate native top level events into event types.
       *
       * @param {string} topLevelType
       * @return {object}
       */
      function getCompositionEventType(topLevelType) {
        switch (topLevelType) {
          case topLevelTypes.topCompositionStart:
            return eventTypes.compositionStart;
          case topLevelTypes.topCompositionEnd:
            return eventTypes.compositionEnd;
          case topLevelTypes.topCompositionUpdate:
            return eventTypes.compositionUpdate;
        }
      }
      
      /**
       * Does our fallback best-guess model think this event signifies that
       * composition has begun?
       *
       * @param {string} topLevelType
       * @param {object} nativeEvent
       * @return {boolean}
       */
      function isFallbackStart(topLevelType, nativeEvent) {
        return (
          topLevelType === topLevelTypes.topKeyDown &&
          nativeEvent.keyCode === START_KEYCODE
        );
      }
      
      /**
       * Does our fallback mode think that this event is the end of composition?
       *
       * @param {string} topLevelType
       * @param {object} nativeEvent
       * @return {boolean}
       */
      function isFallbackEnd(topLevelType, nativeEvent) {
        switch (topLevelType) {
          case topLevelTypes.topKeyUp:
            // Command keys insert or clear IME input.
            return (END_KEYCODES.indexOf(nativeEvent.keyCode) !== -1);
          case topLevelTypes.topKeyDown:
            // Expect IME keyCode on each keydown. If we get any other
            // code we must have exited earlier.
            return (nativeEvent.keyCode !== START_KEYCODE);
          case topLevelTypes.topKeyPress:
          case topLevelTypes.topMouseDown:
          case topLevelTypes.topBlur:
            // Events are not possible without cancelling IME.
            return true;
          default:
            return false;
        }
      }
      
      /**
       * Helper class stores information about selection and document state
       * so we can figure out what changed at a later date.
       *
       * @param {DOMEventTarget} root
       */
      function FallbackCompositionState(root) {
        this.root = root;
        this.startSelection = ReactInputSelection.getSelection(root);
        this.startValue = this.getText();
      }
      
      /**
       * Get current text of input.
       *
       * @return {string}
       */
      FallbackCompositionState.prototype.getText = function() {
        return this.root.value || this.root[getTextContentAccessor()];
      };
      
      /**
       * Text that has changed since the start of composition.
       *
       * @return {string}
       */
      FallbackCompositionState.prototype.getData = function() {
        var endValue = this.getText();
        var prefixLength = this.startSelection.start;
        var suffixLength = this.startValue.length - this.startSelection.end;
      
        return endValue.substr(
          prefixLength,
          endValue.length - suffixLength - prefixLength
        );
      };
      
      /**
       * This plugin creates `onCompositionStart`, `onCompositionUpdate` and
       * `onCompositionEnd` events on inputs, textareas and contentEditable
       * nodes.
       */
      var CompositionEventPlugin = {
      
        eventTypes: eventTypes,
      
        /**
         * @param {string} topLevelType Record from `EventConstants`.
         * @param {DOMEventTarget} topLevelTarget The listening component root node.
         * @param {string} topLevelTargetID ID of `topLevelTarget`.
         * @param {object} nativeEvent Native browser event.
         * @return {*} An accumulation of synthetic events.
         * @see {EventPluginHub.extractEvents}
         */
        extractEvents: function(
            topLevelType,
            topLevelTarget,
            topLevelTargetID,
            nativeEvent) {
      
          var eventType;
          var data;
      
          if (useCompositionEvent) {
            eventType = getCompositionEventType(topLevelType);
          } else if (!currentComposition) {
            if (isFallbackStart(topLevelType, nativeEvent)) {
              eventType = eventTypes.compositionStart;
            }
          } else if (isFallbackEnd(topLevelType, nativeEvent)) {
            eventType = eventTypes.compositionEnd;
          }
      
          if (useFallbackData) {
            // The current composition is stored statically and must not be
            // overwritten while composition continues.
            if (!currentComposition && eventType === eventTypes.compositionStart) {
              currentComposition = new FallbackCompositionState(topLevelTarget);
            } else if (eventType === eventTypes.compositionEnd) {
              if (currentComposition) {
                data = currentComposition.getData();
                currentComposition = null;
              }
            }
          }
      
          if (eventType) {
            var event = SyntheticCompositionEvent.getPooled(
              eventType,
              topLevelTargetID,
              nativeEvent
            );
            if (data) {
              // Inject data generated from fallback path into the synthetic event.
              // This matches the property of native CompositionEventInterface.
              event.data = data;
            }
            EventPropagators.accumulateTwoPhaseDispatches(event);
            return event;
          }
        }
      };
      
      module.exports = CompositionEventPlugin;
      
      },{"./EventConstants":15,"./EventPropagators":20,"./ExecutionEnvironment":21,"./ReactInputSelection":58,"./SyntheticCompositionEvent":82,"./getTextContentAccessor":115,"./keyOf":127}],9:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule DOMChildrenOperations
       * @typechecks static-only
       */
      
      "use strict";
      
      var Danger = _dereq_("./Danger");
      var ReactMultiChildUpdateTypes = _dereq_("./ReactMultiChildUpdateTypes");
      
      var getTextContentAccessor = _dereq_("./getTextContentAccessor");
      var invariant = _dereq_("./invariant");
      
      /**
       * The DOM property to use when setting text content.
       *
       * @type {string}
       * @private
       */
      var textContentAccessor = getTextContentAccessor();
      
      /**
       * Inserts `childNode` as a child of `parentNode` at the `index`.
       *
       * @param {DOMElement} parentNode Parent node in which to insert.
       * @param {DOMElement} childNode Child node to insert.
       * @param {number} index Index at which to insert the child.
       * @internal
       */
      function insertChildAt(parentNode, childNode, index) {
        // By exploiting arrays returning `undefined` for an undefined index, we can
        // rely exclusively on `insertBefore(node, null)` instead of also using
        // `appendChild(node)`. However, using `undefined` is not allowed by all
        // browsers so we must replace it with `null`.
        parentNode.insertBefore(
          childNode,
          parentNode.childNodes[index] || null
        );
      }
      
      var updateTextContent;
      if (textContentAccessor === 'textContent') {
        /**
         * Sets the text content of `node` to `text`.
         *
         * @param {DOMElement} node Node to change
         * @param {string} text New text content
         */
        updateTextContent = function(node, text) {
          node.textContent = text;
        };
      } else {
        /**
         * Sets the text content of `node` to `text`.
         *
         * @param {DOMElement} node Node to change
         * @param {string} text New text content
         */
        updateTextContent = function(node, text) {
          // In order to preserve newlines correctly, we can't use .innerText to set
          // the contents (see #1080), so we empty the element then append a text node
          while (node.firstChild) {
            node.removeChild(node.firstChild);
          }
          if (text) {
            var doc = node.ownerDocument || document;
            node.appendChild(doc.createTextNode(text));
          }
        };
      }
      
      /**
       * Operations for updating with DOM children.
       */
      var DOMChildrenOperations = {
      
        dangerouslyReplaceNodeWithMarkup: Danger.dangerouslyReplaceNodeWithMarkup,
      
        updateTextContent: updateTextContent,
      
        /**
         * Updates a component's children by processing a series of updates. The
         * update configurations are each expected to have a `parentNode` property.
         *
         * @param {array<object>} updates List of update configurations.
         * @param {array<string>} markupList List of markup strings.
         * @internal
         */
        processUpdates: function(updates, markupList) {
          var update;
          // Mapping from parent IDs to initial child orderings.
          var initialChildren = null;
          // List of children that will be moved or removed.
          var updatedChildren = null;
      
          for (var i = 0; update = updates[i]; i++) {
            if (update.type === ReactMultiChildUpdateTypes.MOVE_EXISTING ||
                update.type === ReactMultiChildUpdateTypes.REMOVE_NODE) {
              var updatedIndex = update.fromIndex;
              var updatedChild = update.parentNode.childNodes[updatedIndex];
              var parentID = update.parentID;
      
              ("production" !== "development" ? invariant(
                updatedChild,
                'processUpdates(): Unable to find child %s of element. This ' +
                'probably means the DOM was unexpectedly mutated (e.g., by the ' +
                'browser), usually due to forgetting a <tbody> when using tables, ' +
                'nesting <p> or <a> tags, or using non-SVG elements in an <svg> '+
                'parent. Try inspecting the child nodes of the element with React ' +
                'ID `%s`.',
                updatedIndex,
                parentID
              ) : invariant(updatedChild));
      
              initialChildren = initialChildren || {};
              initialChildren[parentID] = initialChildren[parentID] || [];
              initialChildren[parentID][updatedIndex] = updatedChild;
      
              updatedChildren = updatedChildren || [];
              updatedChildren.push(updatedChild);
            }
          }
      
          var renderedMarkup = Danger.dangerouslyRenderMarkup(markupList);
      
          // Remove updated children first so that `toIndex` is consistent.
          if (updatedChildren) {
            for (var j = 0; j < updatedChildren.length; j++) {
              updatedChildren[j].parentNode.removeChild(updatedChildren[j]);
            }
          }
      
          for (var k = 0; update = updates[k]; k++) {
            switch (update.type) {
              case ReactMultiChildUpdateTypes.INSERT_MARKUP:
                insertChildAt(
                  update.parentNode,
                  renderedMarkup[update.markupIndex],
                  update.toIndex
                );
                break;
              case ReactMultiChildUpdateTypes.MOVE_EXISTING:
                insertChildAt(
                  update.parentNode,
                  initialChildren[update.parentID][update.fromIndex],
                  update.toIndex
                );
                break;
              case ReactMultiChildUpdateTypes.TEXT_CONTENT:
                updateTextContent(
                  update.parentNode,
                  update.textContent
                );
                break;
              case ReactMultiChildUpdateTypes.REMOVE_NODE:
                // Already removed by the for-loop above.
                break;
            }
          }
        }
      
      };
      
      module.exports = DOMChildrenOperations;
      
      },{"./Danger":12,"./ReactMultiChildUpdateTypes":63,"./getTextContentAccessor":115,"./invariant":120}],10:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule DOMProperty
       * @typechecks static-only
       */
      
      /*jslint bitwise: true */
      
      "use strict";
      
      var invariant = _dereq_("./invariant");
      
      var DOMPropertyInjection = {
        /**
         * Mapping from normalized, camelcased property names to a configuration that
         * specifies how the associated DOM property should be accessed or rendered.
         */
        MUST_USE_ATTRIBUTE: 0x1,
        MUST_USE_PROPERTY: 0x2,
        HAS_SIDE_EFFECTS: 0x4,
        HAS_BOOLEAN_VALUE: 0x8,
        HAS_NUMERIC_VALUE: 0x10,
        HAS_POSITIVE_NUMERIC_VALUE: 0x20 | 0x10,
        HAS_OVERLOADED_BOOLEAN_VALUE: 0x40,
      
        /**
         * Inject some specialized knowledge about the DOM. This takes a config object
         * with the following properties:
         *
         * isCustomAttribute: function that given an attribute name will return true
         * if it can be inserted into the DOM verbatim. Useful for data-* or aria-*
         * attributes where it's impossible to enumerate all of the possible
         * attribute names,
         *
         * Properties: object mapping DOM property name to one of the
         * DOMPropertyInjection constants or null. If your attribute isn't in here,
         * it won't get written to the DOM.
         *
         * DOMAttributeNames: object mapping React attribute name to the DOM
         * attribute name. Attribute names not specified use the **lowercase**
         * normalized name.
         *
         * DOMPropertyNames: similar to DOMAttributeNames but for DOM properties.
         * Property names not specified use the normalized name.
         *
         * DOMMutationMethods: Properties that require special mutation methods. If
         * `value` is undefined, the mutation method should unset the property.
         *
         * @param {object} domPropertyConfig the config as described above.
         */
        injectDOMPropertyConfig: function(domPropertyConfig) {
          var Properties = domPropertyConfig.Properties || {};
          var DOMAttributeNames = domPropertyConfig.DOMAttributeNames || {};
          var DOMPropertyNames = domPropertyConfig.DOMPropertyNames || {};
          var DOMMutationMethods = domPropertyConfig.DOMMutationMethods || {};
      
          if (domPropertyConfig.isCustomAttribute) {
            DOMProperty._isCustomAttributeFunctions.push(
              domPropertyConfig.isCustomAttribute
            );
          }
      
          for (var propName in Properties) {
            ("production" !== "development" ? invariant(
              !DOMProperty.isStandardName.hasOwnProperty(propName),
              'injectDOMPropertyConfig(...): You\'re trying to inject DOM property ' +
              '\'%s\' which has already been injected. You may be accidentally ' +
              'injecting the same DOM property config twice, or you may be ' +
              'injecting two configs that have conflicting property names.',
              propName
            ) : invariant(!DOMProperty.isStandardName.hasOwnProperty(propName)));
      
            DOMProperty.isStandardName[propName] = true;
      
            var lowerCased = propName.toLowerCase();
            DOMProperty.getPossibleStandardName[lowerCased] = propName;
      
            if (DOMAttributeNames.hasOwnProperty(propName)) {
              var attributeName = DOMAttributeNames[propName];
              DOMProperty.getPossibleStandardName[attributeName] = propName;
              DOMProperty.getAttributeName[propName] = attributeName;
            } else {
              DOMProperty.getAttributeName[propName] = lowerCased;
            }
      
            DOMProperty.getPropertyName[propName] =
              DOMPropertyNames.hasOwnProperty(propName) ?
                DOMPropertyNames[propName] :
                propName;
      
            if (DOMMutationMethods.hasOwnProperty(propName)) {
              DOMProperty.getMutationMethod[propName] = DOMMutationMethods[propName];
            } else {
              DOMProperty.getMutationMethod[propName] = null;
            }
      
            var propConfig = Properties[propName];
            DOMProperty.mustUseAttribute[propName] =
              propConfig & DOMPropertyInjection.MUST_USE_ATTRIBUTE;
            DOMProperty.mustUseProperty[propName] =
              propConfig & DOMPropertyInjection.MUST_USE_PROPERTY;
            DOMProperty.hasSideEffects[propName] =
              propConfig & DOMPropertyInjection.HAS_SIDE_EFFECTS;
            DOMProperty.hasBooleanValue[propName] =
              propConfig & DOMPropertyInjection.HAS_BOOLEAN_VALUE;
            DOMProperty.hasNumericValue[propName] =
              propConfig & DOMPropertyInjection.HAS_NUMERIC_VALUE;
            DOMProperty.hasPositiveNumericValue[propName] =
              propConfig & DOMPropertyInjection.HAS_POSITIVE_NUMERIC_VALUE;
            DOMProperty.hasOverloadedBooleanValue[propName] =
              propConfig & DOMPropertyInjection.HAS_OVERLOADED_BOOLEAN_VALUE;
      
            ("production" !== "development" ? invariant(
              !DOMProperty.mustUseAttribute[propName] ||
                !DOMProperty.mustUseProperty[propName],
              'DOMProperty: Cannot require using both attribute and property: %s',
              propName
            ) : invariant(!DOMProperty.mustUseAttribute[propName] ||
              !DOMProperty.mustUseProperty[propName]));
            ("production" !== "development" ? invariant(
              DOMProperty.mustUseProperty[propName] ||
                !DOMProperty.hasSideEffects[propName],
              'DOMProperty: Properties that have side effects must use property: %s',
              propName
            ) : invariant(DOMProperty.mustUseProperty[propName] ||
              !DOMProperty.hasSideEffects[propName]));
            ("production" !== "development" ? invariant(
              !!DOMProperty.hasBooleanValue[propName] +
                !!DOMProperty.hasNumericValue[propName] +
                !!DOMProperty.hasOverloadedBooleanValue[propName] <= 1,
              'DOMProperty: Value can be one of boolean, overloaded boolean, or ' +
              'numeric value, but not a combination: %s',
              propName
            ) : invariant(!!DOMProperty.hasBooleanValue[propName] +
              !!DOMProperty.hasNumericValue[propName] +
              !!DOMProperty.hasOverloadedBooleanValue[propName] <= 1));
          }
        }
      };
      var defaultValueCache = {};
      
      /**
       * DOMProperty exports lookup objects that can be used like functions:
       *
       *   > DOMProperty.isValid['id']
       *   true
       *   > DOMProperty.isValid['foobar']
       *   undefined
       *
       * Although this may be confusing, it performs better in general.
       *
       * @see http://jsperf.com/key-exists
       * @see http://jsperf.com/key-missing
       */
      var DOMProperty = {
      
        ID_ATTRIBUTE_NAME: 'data-reactid',
      
        /**
         * Checks whether a property name is a standard property.
         * @type {Object}
         */
        isStandardName: {},
      
        /**
         * Mapping from lowercase property names to the properly cased version, used
         * to warn in the case of missing properties.
         * @type {Object}
         */
        getPossibleStandardName: {},
      
        /**
         * Mapping from normalized names to attribute names that differ. Attribute
         * names are used when rendering markup or with `*Attribute()`.
         * @type {Object}
         */
        getAttributeName: {},
      
        /**
         * Mapping from normalized names to properties on DOM node instances.
         * (This includes properties that mutate due to external factors.)
         * @type {Object}
         */
        getPropertyName: {},
      
        /**
         * Mapping from normalized names to mutation methods. This will only exist if
         * mutation cannot be set simply by the property or `setAttribute()`.
         * @type {Object}
         */
        getMutationMethod: {},
      
        /**
         * Whether the property must be accessed and mutated as an object property.
         * @type {Object}
         */
        mustUseAttribute: {},
      
        /**
         * Whether the property must be accessed and mutated using `*Attribute()`.
         * (This includes anything that fails `<propName> in <element>`.)
         * @type {Object}
         */
        mustUseProperty: {},
      
        /**
         * Whether or not setting a value causes side effects such as triggering
         * resources to be loaded or text selection changes. We must ensure that
         * the value is only set if it has changed.
         * @type {Object}
         */
        hasSideEffects: {},
      
        /**
         * Whether the property should be removed when set to a falsey value.
         * @type {Object}
         */
        hasBooleanValue: {},
      
        /**
         * Whether the property must be numeric or parse as a
         * numeric and should be removed when set to a falsey value.
         * @type {Object}
         */
        hasNumericValue: {},
      
        /**
         * Whether the property must be positive numeric or parse as a positive
         * numeric and should be removed when set to a falsey value.
         * @type {Object}
         */
        hasPositiveNumericValue: {},
      
        /**
         * Whether the property can be used as a flag as well as with a value. Removed
         * when strictly equal to false; present without a value when strictly equal
         * to true; present with a value otherwise.
         * @type {Object}
         */
        hasOverloadedBooleanValue: {},
      
        /**
         * All of the isCustomAttribute() functions that have been injected.
         */
        _isCustomAttributeFunctions: [],
      
        /**
         * Checks whether a property name is a custom attribute.
         * @method
         */
        isCustomAttribute: function(attributeName) {
          for (var i = 0; i < DOMProperty._isCustomAttributeFunctions.length; i++) {
            var isCustomAttributeFn = DOMProperty._isCustomAttributeFunctions[i];
            if (isCustomAttributeFn(attributeName)) {
              return true;
            }
          }
          return false;
        },
      
        /**
         * Returns the default property value for a DOM property (i.e., not an
         * attribute). Most default values are '' or false, but not all. Worse yet,
         * some (in particular, `type`) vary depending on the type of element.
         *
         * TODO: Is it better to grab all the possible properties when creating an
         * element to avoid having to create the same element twice?
         */
        getDefaultValueForProperty: function(nodeName, prop) {
          var nodeDefaults = defaultValueCache[nodeName];
          var testElement;
          if (!nodeDefaults) {
            defaultValueCache[nodeName] = nodeDefaults = {};
          }
          if (!(prop in nodeDefaults)) {
            testElement = document.createElement(nodeName);
            nodeDefaults[prop] = testElement[prop];
          }
          return nodeDefaults[prop];
        },
      
        injection: DOMPropertyInjection
      };
      
      module.exports = DOMProperty;
      
      },{"./invariant":120}],11:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule DOMPropertyOperations
       * @typechecks static-only
       */
      
      "use strict";
      
      var DOMProperty = _dereq_("./DOMProperty");
      
      var escapeTextForBrowser = _dereq_("./escapeTextForBrowser");
      var memoizeStringOnly = _dereq_("./memoizeStringOnly");
      var warning = _dereq_("./warning");
      
      function shouldIgnoreValue(name, value) {
        return value == null ||
          (DOMProperty.hasBooleanValue[name] && !value) ||
          (DOMProperty.hasNumericValue[name] && isNaN(value)) ||
          (DOMProperty.hasPositiveNumericValue[name] && (value < 1)) ||
          (DOMProperty.hasOverloadedBooleanValue[name] && value === false);
      }
      
      var processAttributeNameAndPrefix = memoizeStringOnly(function(name) {
        return escapeTextForBrowser(name) + '="';
      });
      
      if ("production" !== "development") {
        var reactProps = {
          children: true,
          dangerouslySetInnerHTML: true,
          key: true,
          ref: true
        };
        var warnedProperties = {};
      
        var warnUnknownProperty = function(name) {
          if (reactProps.hasOwnProperty(name) && reactProps[name] ||
              warnedProperties.hasOwnProperty(name) && warnedProperties[name]) {
            return;
          }
      
          warnedProperties[name] = true;
          var lowerCasedName = name.toLowerCase();
      
          // data-* attributes should be lowercase; suggest the lowercase version
          var standardName = (
            DOMProperty.isCustomAttribute(lowerCasedName) ?
              lowerCasedName :
            DOMProperty.getPossibleStandardName.hasOwnProperty(lowerCasedName) ?
              DOMProperty.getPossibleStandardName[lowerCasedName] :
              null
          );
      
          // For now, only warn when we have a suggested correction. This prevents
          // logging too much when using transferPropsTo.
          ("production" !== "development" ? warning(
            standardName == null,
            'Unknown DOM property ' + name + '. Did you mean ' + standardName + '?'
          ) : null);
      
        };
      }
      
      /**
       * Operations for dealing with DOM properties.
       */
      var DOMPropertyOperations = {
      
        /**
         * Creates markup for the ID property.
         *
         * @param {string} id Unescaped ID.
         * @return {string} Markup string.
         */
        createMarkupForID: function(id) {
          return processAttributeNameAndPrefix(DOMProperty.ID_ATTRIBUTE_NAME) +
            escapeTextForBrowser(id) + '"';
        },
      
        /**
         * Creates markup for a property.
         *
         * @param {string} name
         * @param {*} value
         * @return {?string} Markup string, or null if the property was invalid.
         */
        createMarkupForProperty: function(name, value) {
          if (DOMProperty.isStandardName.hasOwnProperty(name) &&
              DOMProperty.isStandardName[name]) {
            if (shouldIgnoreValue(name, value)) {
              return '';
            }
            var attributeName = DOMProperty.getAttributeName[name];
            if (DOMProperty.hasBooleanValue[name] ||
                (DOMProperty.hasOverloadedBooleanValue[name] && value === true)) {
              return escapeTextForBrowser(attributeName);
            }
            return processAttributeNameAndPrefix(attributeName) +
              escapeTextForBrowser(value) + '"';
          } else if (DOMProperty.isCustomAttribute(name)) {
            if (value == null) {
              return '';
            }
            return processAttributeNameAndPrefix(name) +
              escapeTextForBrowser(value) + '"';
          } else if ("production" !== "development") {
            warnUnknownProperty(name);
          }
          return null;
        },
      
        /**
         * Sets the value for a property on a node.
         *
         * @param {DOMElement} node
         * @param {string} name
         * @param {*} value
         */
        setValueForProperty: function(node, name, value) {
          if (DOMProperty.isStandardName.hasOwnProperty(name) &&
              DOMProperty.isStandardName[name]) {
            var mutationMethod = DOMProperty.getMutationMethod[name];
            if (mutationMethod) {
              mutationMethod(node, value);
            } else if (shouldIgnoreValue(name, value)) {
              this.deleteValueForProperty(node, name);
            } else if (DOMProperty.mustUseAttribute[name]) {
              node.setAttribute(DOMProperty.getAttributeName[name], '' + value);
            } else {
              var propName = DOMProperty.getPropertyName[name];
              if (!DOMProperty.hasSideEffects[name] || node[propName] !== value) {
                node[propName] = value;
              }
            }
          } else if (DOMProperty.isCustomAttribute(name)) {
            if (value == null) {
              node.removeAttribute(name);
            } else {
              node.setAttribute(name, '' + value);
            }
          } else if ("production" !== "development") {
            warnUnknownProperty(name);
          }
        },
      
        /**
         * Deletes the value for a property on a node.
         *
         * @param {DOMElement} node
         * @param {string} name
         */
        deleteValueForProperty: function(node, name) {
          if (DOMProperty.isStandardName.hasOwnProperty(name) &&
              DOMProperty.isStandardName[name]) {
            var mutationMethod = DOMProperty.getMutationMethod[name];
            if (mutationMethod) {
              mutationMethod(node, undefined);
            } else if (DOMProperty.mustUseAttribute[name]) {
              node.removeAttribute(DOMProperty.getAttributeName[name]);
            } else {
              var propName = DOMProperty.getPropertyName[name];
              var defaultValue = DOMProperty.getDefaultValueForProperty(
                node.nodeName,
                propName
              );
              if (!DOMProperty.hasSideEffects[name] ||
                  node[propName] !== defaultValue) {
                node[propName] = defaultValue;
              }
            }
          } else if (DOMProperty.isCustomAttribute(name)) {
            node.removeAttribute(name);
          } else if ("production" !== "development") {
            warnUnknownProperty(name);
          }
        }
      
      };
      
      module.exports = DOMPropertyOperations;
      
      },{"./DOMProperty":10,"./escapeTextForBrowser":104,"./memoizeStringOnly":129,"./warning":143}],12:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule Danger
       * @typechecks static-only
       */
      
      /*jslint evil: true, sub: true */
      
      "use strict";
      
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      
      var createNodesFromMarkup = _dereq_("./createNodesFromMarkup");
      var emptyFunction = _dereq_("./emptyFunction");
      var getMarkupWrap = _dereq_("./getMarkupWrap");
      var invariant = _dereq_("./invariant");
      
      var OPEN_TAG_NAME_EXP = /^(<[^ \/>]+)/;
      var RESULT_INDEX_ATTR = 'data-danger-index';
      
      /**
       * Extracts the `nodeName` from a string of markup.
       *
       * NOTE: Extracting the `nodeName` does not require a regular expression match
       * because we make assumptions about React-generated markup (i.e. there are no
       * spaces surrounding the opening tag and there is at least one attribute).
       *
       * @param {string} markup String of markup.
       * @return {string} Node name of the supplied markup.
       * @see http://jsperf.com/extract-nodename
       */
      function getNodeName(markup) {
        return markup.substring(1, markup.indexOf(' '));
      }
      
      var Danger = {
      
        /**
         * Renders markup into an array of nodes. The markup is expected to render
         * into a list of root nodes. Also, the length of `resultList` and
         * `markupList` should be the same.
         *
         * @param {array<string>} markupList List of markup strings to render.
         * @return {array<DOMElement>} List of rendered nodes.
         * @internal
         */
        dangerouslyRenderMarkup: function(markupList) {
          ("production" !== "development" ? invariant(
            ExecutionEnvironment.canUseDOM,
            'dangerouslyRenderMarkup(...): Cannot render markup in a Worker ' +
            'thread. This is likely a bug in the framework. Please report ' +
            'immediately.'
          ) : invariant(ExecutionEnvironment.canUseDOM));
          var nodeName;
          var markupByNodeName = {};
          // Group markup by `nodeName` if a wrap is necessary, else by '*'.
          for (var i = 0; i < markupList.length; i++) {
            ("production" !== "development" ? invariant(
              markupList[i],
              'dangerouslyRenderMarkup(...): Missing markup.'
            ) : invariant(markupList[i]));
            nodeName = getNodeName(markupList[i]);
            nodeName = getMarkupWrap(nodeName) ? nodeName : '*';
            markupByNodeName[nodeName] = markupByNodeName[nodeName] || [];
            markupByNodeName[nodeName][i] = markupList[i];
          }
          var resultList = [];
          var resultListAssignmentCount = 0;
          for (nodeName in markupByNodeName) {
            if (!markupByNodeName.hasOwnProperty(nodeName)) {
              continue;
            }
            var markupListByNodeName = markupByNodeName[nodeName];
      
            // This for-in loop skips the holes of the sparse array. The order of
            // iteration should follow the order of assignment, which happens to match
            // numerical index order, but we don't rely on that.
            for (var resultIndex in markupListByNodeName) {
              if (markupListByNodeName.hasOwnProperty(resultIndex)) {
                var markup = markupListByNodeName[resultIndex];
      
                // Push the requested markup with an additional RESULT_INDEX_ATTR
                // attribute.  If the markup does not start with a < character, it
                // will be discarded below (with an appropriate console.error).
                markupListByNodeName[resultIndex] = markup.replace(
                  OPEN_TAG_NAME_EXP,
                  // This index will be parsed back out below.
                  '$1 ' + RESULT_INDEX_ATTR + '="' + resultIndex + '" '
                );
              }
            }
      
            // Render each group of markup with similar wrapping `nodeName`.
            var renderNodes = createNodesFromMarkup(
              markupListByNodeName.join(''),
              emptyFunction // Do nothing special with <script> tags.
            );
      
            for (i = 0; i < renderNodes.length; ++i) {
              var renderNode = renderNodes[i];
              if (renderNode.hasAttribute &&
                  renderNode.hasAttribute(RESULT_INDEX_ATTR)) {
      
                resultIndex = +renderNode.getAttribute(RESULT_INDEX_ATTR);
                renderNode.removeAttribute(RESULT_INDEX_ATTR);
      
                ("production" !== "development" ? invariant(
                  !resultList.hasOwnProperty(resultIndex),
                  'Danger: Assigning to an already-occupied result index.'
                ) : invariant(!resultList.hasOwnProperty(resultIndex)));
      
                resultList[resultIndex] = renderNode;
      
                // This should match resultList.length and markupList.length when
                // we're done.
                resultListAssignmentCount += 1;
      
              } else if ("production" !== "development") {
                console.error(
                  "Danger: Discarding unexpected node:",
                  renderNode
                );
              }
            }
          }
      
          // Although resultList was populated out of order, it should now be a dense
          // array.
          ("production" !== "development" ? invariant(
            resultListAssignmentCount === resultList.length,
            'Danger: Did not assign to every index of resultList.'
          ) : invariant(resultListAssignmentCount === resultList.length));
      
          ("production" !== "development" ? invariant(
            resultList.length === markupList.length,
            'Danger: Expected markup to render %s nodes, but rendered %s.',
            markupList.length,
            resultList.length
          ) : invariant(resultList.length === markupList.length));
      
          return resultList;
        },
      
        /**
         * Replaces a node with a string of markup at its current position within its
         * parent. The markup must render into a single root node.
         *
         * @param {DOMElement} oldChild Child node to replace.
         * @param {string} markup Markup to render in place of the child node.
         * @internal
         */
        dangerouslyReplaceNodeWithMarkup: function(oldChild, markup) {
          ("production" !== "development" ? invariant(
            ExecutionEnvironment.canUseDOM,
            'dangerouslyReplaceNodeWithMarkup(...): Cannot render markup in a ' +
            'worker thread. This is likely a bug in the framework. Please report ' +
            'immediately.'
          ) : invariant(ExecutionEnvironment.canUseDOM));
          ("production" !== "development" ? invariant(markup, 'dangerouslyReplaceNodeWithMarkup(...): Missing markup.') : invariant(markup));
          ("production" !== "development" ? invariant(
            oldChild.tagName.toLowerCase() !== 'html',
            'dangerouslyReplaceNodeWithMarkup(...): Cannot replace markup of the ' +
            '<html> node. This is because browser quirks make this unreliable ' +
            'and/or slow. If you want to render to the root you must use ' +
            'server rendering. See renderComponentToString().'
          ) : invariant(oldChild.tagName.toLowerCase() !== 'html'));
      
          var newChild = createNodesFromMarkup(markup, emptyFunction)[0];
          oldChild.parentNode.replaceChild(newChild, oldChild);
        }
      
      };
      
      module.exports = Danger;
      
      },{"./ExecutionEnvironment":21,"./createNodesFromMarkup":100,"./emptyFunction":102,"./getMarkupWrap":112,"./invariant":120}],13:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule DefaultEventPluginOrder
       */
      
      "use strict";
      
       var keyOf = _dereq_("./keyOf");
      
      /**
       * Module that is injectable into `EventPluginHub`, that specifies a
       * deterministic ordering of `EventPlugin`s. A convenient way to reason about
       * plugins, without having to package every one of them. This is better than
       * having plugins be ordered in the same order that they are injected because
       * that ordering would be influenced by the packaging order.
       * `ResponderEventPlugin` must occur before `SimpleEventPlugin` so that
       * preventing default on events is convenient in `SimpleEventPlugin` handlers.
       */
      var DefaultEventPluginOrder = [
        keyOf({ResponderEventPlugin: null}),
        keyOf({SimpleEventPlugin: null}),
        keyOf({TapEventPlugin: null}),
        keyOf({EnterLeaveEventPlugin: null}),
        keyOf({ChangeEventPlugin: null}),
        keyOf({SelectEventPlugin: null}),
        keyOf({CompositionEventPlugin: null}),
        keyOf({BeforeInputEventPlugin: null}),
        keyOf({AnalyticsEventPlugin: null}),
        keyOf({MobileSafariClickEventPlugin: null})
      ];
      
      module.exports = DefaultEventPluginOrder;
      
      },{"./keyOf":127}],14:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule EnterLeaveEventPlugin
       * @typechecks static-only
       */
      
      "use strict";
      
      var EventConstants = _dereq_("./EventConstants");
      var EventPropagators = _dereq_("./EventPropagators");
      var SyntheticMouseEvent = _dereq_("./SyntheticMouseEvent");
      
      var ReactMount = _dereq_("./ReactMount");
      var keyOf = _dereq_("./keyOf");
      
      var topLevelTypes = EventConstants.topLevelTypes;
      var getFirstReactDOM = ReactMount.getFirstReactDOM;
      
      var eventTypes = {
        mouseEnter: {
          registrationName: keyOf({onMouseEnter: null}),
          dependencies: [
            topLevelTypes.topMouseOut,
            topLevelTypes.topMouseOver
          ]
        },
        mouseLeave: {
          registrationName: keyOf({onMouseLeave: null}),
          dependencies: [
            topLevelTypes.topMouseOut,
            topLevelTypes.topMouseOver
          ]
        }
      };
      
      var extractedEvents = [null, null];
      
      var EnterLeaveEventPlugin = {
      
        eventTypes: eventTypes,
      
        /**
         * For almost every interaction we care about, there will be both a top-level
         * `mouseover` and `mouseout` event that occurs. Only use `mouseout` so that
         * we do not extract duplicate events. However, moving the mouse into the
         * browser from outside will not fire a `mouseout` event. In this case, we use
         * the `mouseover` top-level event.
         *
         * @param {string} topLevelType Record from `EventConstants`.
         * @param {DOMEventTarget} topLevelTarget The listening component root node.
         * @param {string} topLevelTargetID ID of `topLevelTarget`.
         * @param {object} nativeEvent Native browser event.
         * @return {*} An accumulation of synthetic events.
         * @see {EventPluginHub.extractEvents}
         */
        extractEvents: function(
            topLevelType,
            topLevelTarget,
            topLevelTargetID,
            nativeEvent) {
          if (topLevelType === topLevelTypes.topMouseOver &&
              (nativeEvent.relatedTarget || nativeEvent.fromElement)) {
            return null;
          }
          if (topLevelType !== topLevelTypes.topMouseOut &&
              topLevelType !== topLevelTypes.topMouseOver) {
            // Must not be a mouse in or mouse out - ignoring.
            return null;
          }
      
          var win;
          if (topLevelTarget.window === topLevelTarget) {
            // `topLevelTarget` is probably a window object.
            win = topLevelTarget;
          } else {
            // TODO: Figure out why `ownerDocument` is sometimes undefined in IE8.
            var doc = topLevelTarget.ownerDocument;
            if (doc) {
              win = doc.defaultView || doc.parentWindow;
            } else {
              win = window;
            }
          }
      
          var from, to;
          if (topLevelType === topLevelTypes.topMouseOut) {
            from = topLevelTarget;
            to =
              getFirstReactDOM(nativeEvent.relatedTarget || nativeEvent.toElement) ||
              win;
          } else {
            from = win;
            to = topLevelTarget;
          }
      
          if (from === to) {
            // Nothing pertains to our managed components.
            return null;
          }
      
          var fromID = from ? ReactMount.getID(from) : '';
          var toID = to ? ReactMount.getID(to) : '';
      
          var leave = SyntheticMouseEvent.getPooled(
            eventTypes.mouseLeave,
            fromID,
            nativeEvent
          );
          leave.type = 'mouseleave';
          leave.target = from;
          leave.relatedTarget = to;
      
          var enter = SyntheticMouseEvent.getPooled(
            eventTypes.mouseEnter,
            toID,
            nativeEvent
          );
          enter.type = 'mouseenter';
          enter.target = to;
          enter.relatedTarget = from;
      
          EventPropagators.accumulateEnterLeaveDispatches(leave, enter, fromID, toID);
      
          extractedEvents[0] = leave;
          extractedEvents[1] = enter;
      
          return extractedEvents;
        }
      
      };
      
      module.exports = EnterLeaveEventPlugin;
      
      },{"./EventConstants":15,"./EventPropagators":20,"./ReactMount":61,"./SyntheticMouseEvent":88,"./keyOf":127}],15:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule EventConstants
       */
      
      "use strict";
      
      var keyMirror = _dereq_("./keyMirror");
      
      var PropagationPhases = keyMirror({bubbled: null, captured: null});
      
      /**
       * Types of raw signals from the browser caught at the top level.
       */
      var topLevelTypes = keyMirror({
        topBlur: null,
        topChange: null,
        topClick: null,
        topCompositionEnd: null,
        topCompositionStart: null,
        topCompositionUpdate: null,
        topContextMenu: null,
        topCopy: null,
        topCut: null,
        topDoubleClick: null,
        topDrag: null,
        topDragEnd: null,
        topDragEnter: null,
        topDragExit: null,
        topDragLeave: null,
        topDragOver: null,
        topDragStart: null,
        topDrop: null,
        topError: null,
        topFocus: null,
        topInput: null,
        topKeyDown: null,
        topKeyPress: null,
        topKeyUp: null,
        topLoad: null,
        topMouseDown: null,
        topMouseMove: null,
        topMouseOut: null,
        topMouseOver: null,
        topMouseUp: null,
        topPaste: null,
        topReset: null,
        topScroll: null,
        topSelectionChange: null,
        topSubmit: null,
        topTextInput: null,
        topTouchCancel: null,
        topTouchEnd: null,
        topTouchMove: null,
        topTouchStart: null,
        topWheel: null
      });
      
      var EventConstants = {
        topLevelTypes: topLevelTypes,
        PropagationPhases: PropagationPhases
      };
      
      module.exports = EventConstants;
      
      },{"./keyMirror":126}],16:[function(_dereq_,module,exports){
      /**
       * @providesModule EventListener
       * @typechecks
       */
      
      var emptyFunction = _dereq_("./emptyFunction");
      
      /**
       * Upstream version of event listener. Does not take into account specific
       * nature of platform.
       */
      var EventListener = {
        /**
         * Listen to DOM events during the bubble phase.
         *
         * @param {DOMEventTarget} target DOM element to register listener on.
         * @param {string} eventType Event type, e.g. 'click' or 'mouseover'.
         * @param {function} callback Callback function.
         * @return {object} Object with a `remove` method.
         */
        listen: function(target, eventType, callback) {
          if (target.addEventListener) {
            target.addEventListener(eventType, callback, false);
            return {
              remove: function() {
                target.removeEventListener(eventType, callback, false);
              }
            };
          } else if (target.attachEvent) {
            target.attachEvent('on' + eventType, callback);
            return {
              remove: function() {
                target.detachEvent('on' + eventType, callback);
              }
            };
          }
        },
      
        /**
         * Listen to DOM events during the capture phase.
         *
         * @param {DOMEventTarget} target DOM element to register listener on.
         * @param {string} eventType Event type, e.g. 'click' or 'mouseover'.
         * @param {function} callback Callback function.
         * @return {object} Object with a `remove` method.
         */
        capture: function(target, eventType, callback) {
          if (!target.addEventListener) {
            if ("production" !== "development") {
              console.error(
                'Attempted to listen to events during the capture phase on a ' +
                'browser that does not support the capture phase. Your application ' +
                'will not receive some events.'
              );
            }
            return {
              remove: emptyFunction
            };
          } else {
            target.addEventListener(eventType, callback, true);
            return {
              remove: function() {
                target.removeEventListener(eventType, callback, true);
              }
            };
          }
        },
      
        registerDefault: function() {}
      };
      
      module.exports = EventListener;
      
      },{"./emptyFunction":102}],17:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule EventPluginHub
       */
      
      "use strict";
      
      var EventPluginRegistry = _dereq_("./EventPluginRegistry");
      var EventPluginUtils = _dereq_("./EventPluginUtils");
      
      var accumulate = _dereq_("./accumulate");
      var forEachAccumulated = _dereq_("./forEachAccumulated");
      var invariant = _dereq_("./invariant");
      var isEventSupported = _dereq_("./isEventSupported");
      var monitorCodeUse = _dereq_("./monitorCodeUse");
      
      /**
       * Internal store for event listeners
       */
      var listenerBank = {};
      
      /**
       * Internal queue of events that have accumulated their dispatches and are
       * waiting to have their dispatches executed.
       */
      var eventQueue = null;
      
      /**
       * Dispatches an event and releases it back into the pool, unless persistent.
       *
       * @param {?object} event Synthetic event to be dispatched.
       * @private
       */
      var executeDispatchesAndRelease = function(event) {
        if (event) {
          var executeDispatch = EventPluginUtils.executeDispatch;
          // Plugins can provide custom behavior when dispatching events.
          var PluginModule = EventPluginRegistry.getPluginModuleForEvent(event);
          if (PluginModule && PluginModule.executeDispatch) {
            executeDispatch = PluginModule.executeDispatch;
          }
          EventPluginUtils.executeDispatchesInOrder(event, executeDispatch);
      
          if (!event.isPersistent()) {
            event.constructor.release(event);
          }
        }
      };
      
      /**
       * - `InstanceHandle`: [required] Module that performs logical traversals of DOM
       *   hierarchy given ids of the logical DOM elements involved.
       */
      var InstanceHandle = null;
      
      function validateInstanceHandle() {
        var invalid = !InstanceHandle||
          !InstanceHandle.traverseTwoPhase ||
          !InstanceHandle.traverseEnterLeave;
        if (invalid) {
          throw new Error('InstanceHandle not injected before use!');
        }
      }
      
      /**
       * This is a unified interface for event plugins to be installed and configured.
       *
       * Event plugins can implement the following properties:
       *
       *   `extractEvents` {function(string, DOMEventTarget, string, object): *}
       *     Required. When a top-level event is fired, this method is expected to
       *     extract synthetic events that will in turn be queued and dispatched.
       *
       *   `eventTypes` {object}
       *     Optional, plugins that fire events must publish a mapping of registration
       *     names that are used to register listeners. Values of this mapping must
       *     be objects that contain `registrationName` or `phasedRegistrationNames`.
       *
       *   `executeDispatch` {function(object, function, string)}
       *     Optional, allows plugins to override how an event gets dispatched. By
       *     default, the listener is simply invoked.
       *
       * Each plugin that is injected into `EventsPluginHub` is immediately operable.
       *
       * @public
       */
      var EventPluginHub = {
      
        /**
         * Methods for injecting dependencies.
         */
        injection: {
      
          /**
           * @param {object} InjectedMount
           * @public
           */
          injectMount: EventPluginUtils.injection.injectMount,
      
          /**
           * @param {object} InjectedInstanceHandle
           * @public
           */
          injectInstanceHandle: function(InjectedInstanceHandle) {
            InstanceHandle = InjectedInstanceHandle;
            if ("production" !== "development") {
              validateInstanceHandle();
            }
          },
      
          getInstanceHandle: function() {
            if ("production" !== "development") {
              validateInstanceHandle();
            }
            return InstanceHandle;
          },
      
          /**
           * @param {array} InjectedEventPluginOrder
           * @public
           */
          injectEventPluginOrder: EventPluginRegistry.injectEventPluginOrder,
      
          /**
           * @param {object} injectedNamesToPlugins Map from names to plugin modules.
           */
          injectEventPluginsByName: EventPluginRegistry.injectEventPluginsByName
      
        },
      
        eventNameDispatchConfigs: EventPluginRegistry.eventNameDispatchConfigs,
      
        registrationNameModules: EventPluginRegistry.registrationNameModules,
      
        /**
         * Stores `listener` at `listenerBank[registrationName][id]`. Is idempotent.
         *
         * @param {string} id ID of the DOM element.
         * @param {string} registrationName Name of listener (e.g. `onClick`).
         * @param {?function} listener The callback to store.
         */
        putListener: function(id, registrationName, listener) {
          ("production" !== "development" ? invariant(
            !listener || typeof listener === 'function',
            'Expected %s listener to be a function, instead got type %s',
            registrationName, typeof listener
          ) : invariant(!listener || typeof listener === 'function'));
      
          if ("production" !== "development") {
            // IE8 has no API for event capturing and the `onScroll` event doesn't
            // bubble.
            if (registrationName === 'onScroll' &&
                !isEventSupported('scroll', true)) {
              monitorCodeUse('react_no_scroll_event');
              console.warn('This browser doesn\'t support the `onScroll` event');
            }
          }
          var bankForRegistrationName =
            listenerBank[registrationName] || (listenerBank[registrationName] = {});
          bankForRegistrationName[id] = listener;
        },
      
        /**
         * @param {string} id ID of the DOM element.
         * @param {string} registrationName Name of listener (e.g. `onClick`).
         * @return {?function} The stored callback.
         */
        getListener: function(id, registrationName) {
          var bankForRegistrationName = listenerBank[registrationName];
          return bankForRegistrationName && bankForRegistrationName[id];
        },
      
        /**
         * Deletes a listener from the registration bank.
         *
         * @param {string} id ID of the DOM element.
         * @param {string} registrationName Name of listener (e.g. `onClick`).
         */
        deleteListener: function(id, registrationName) {
          var bankForRegistrationName = listenerBank[registrationName];
          if (bankForRegistrationName) {
            delete bankForRegistrationName[id];
          }
        },
      
        /**
         * Deletes all listeners for the DOM element with the supplied ID.
         *
         * @param {string} id ID of the DOM element.
         */
        deleteAllListeners: function(id) {
          for (var registrationName in listenerBank) {
            delete listenerBank[registrationName][id];
          }
        },
      
        /**
         * Allows registered plugins an opportunity to extract events from top-level
         * native browser events.
         *
         * @param {string} topLevelType Record from `EventConstants`.
         * @param {DOMEventTarget} topLevelTarget The listening component root node.
         * @param {string} topLevelTargetID ID of `topLevelTarget`.
         * @param {object} nativeEvent Native browser event.
         * @return {*} An accumulation of synthetic events.
         * @internal
         */
        extractEvents: function(
            topLevelType,
            topLevelTarget,
            topLevelTargetID,
            nativeEvent) {
          var events;
          var plugins = EventPluginRegistry.plugins;
          for (var i = 0, l = plugins.length; i < l; i++) {
            // Not every plugin in the ordering may be loaded at runtime.
            var possiblePlugin = plugins[i];
            if (possiblePlugin) {
              var extractedEvents = possiblePlugin.extractEvents(
                topLevelType,
                topLevelTarget,
                topLevelTargetID,
                nativeEvent
              );
              if (extractedEvents) {
                events = accumulate(events, extractedEvents);
              }
            }
          }
          return events;
        },
      
        /**
         * Enqueues a synthetic event that should be dispatched when
         * `processEventQueue` is invoked.
         *
         * @param {*} events An accumulation of synthetic events.
         * @internal
         */
        enqueueEvents: function(events) {
          if (events) {
            eventQueue = accumulate(eventQueue, events);
          }
        },
      
        /**
         * Dispatches all synthetic events on the event queue.
         *
         * @internal
         */
        processEventQueue: function() {
          // Set `eventQueue` to null before processing it so that we can tell if more
          // events get enqueued while processing.
          var processingEventQueue = eventQueue;
          eventQueue = null;
          forEachAccumulated(processingEventQueue, executeDispatchesAndRelease);
          ("production" !== "development" ? invariant(
            !eventQueue,
            'processEventQueue(): Additional events were enqueued while processing ' +
            'an event queue. Support for this has not yet been implemented.'
          ) : invariant(!eventQueue));
        },
      
        /**
         * These are needed for tests only. Do not use!
         */
        __purge: function() {
          listenerBank = {};
        },
      
        __getListenerBank: function() {
          return listenerBank;
        }
      
      };
      
      module.exports = EventPluginHub;
      
      },{"./EventPluginRegistry":18,"./EventPluginUtils":19,"./accumulate":94,"./forEachAccumulated":107,"./invariant":120,"./isEventSupported":121,"./monitorCodeUse":134}],18:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule EventPluginRegistry
       * @typechecks static-only
       */
      
      "use strict";
      
      var invariant = _dereq_("./invariant");
      
      /**
       * Injectable ordering of event plugins.
       */
      var EventPluginOrder = null;
      
      /**
       * Injectable mapping from names to event plugin modules.
       */
      var namesToPlugins = {};
      
      /**
       * Recomputes the plugin list using the injected plugins and plugin ordering.
       *
       * @private
       */
      function recomputePluginOrdering() {
        if (!EventPluginOrder) {
          // Wait until an `EventPluginOrder` is injected.
          return;
        }
        for (var pluginName in namesToPlugins) {
          var PluginModule = namesToPlugins[pluginName];
          var pluginIndex = EventPluginOrder.indexOf(pluginName);
          ("production" !== "development" ? invariant(
            pluginIndex > -1,
            'EventPluginRegistry: Cannot inject event plugins that do not exist in ' +
            'the plugin ordering, `%s`.',
            pluginName
          ) : invariant(pluginIndex > -1));
          if (EventPluginRegistry.plugins[pluginIndex]) {
            continue;
          }
          ("production" !== "development" ? invariant(
            PluginModule.extractEvents,
            'EventPluginRegistry: Event plugins must implement an `extractEvents` ' +
            'method, but `%s` does not.',
            pluginName
          ) : invariant(PluginModule.extractEvents));
          EventPluginRegistry.plugins[pluginIndex] = PluginModule;
          var publishedEvents = PluginModule.eventTypes;
          for (var eventName in publishedEvents) {
            ("production" !== "development" ? invariant(
              publishEventForPlugin(
                publishedEvents[eventName],
                PluginModule,
                eventName
              ),
              'EventPluginRegistry: Failed to publish event `%s` for plugin `%s`.',
              eventName,
              pluginName
            ) : invariant(publishEventForPlugin(
              publishedEvents[eventName],
              PluginModule,
              eventName
            )));
          }
        }
      }
      
      /**
       * Publishes an event so that it can be dispatched by the supplied plugin.
       *
       * @param {object} dispatchConfig Dispatch configuration for the event.
       * @param {object} PluginModule Plugin publishing the event.
       * @return {boolean} True if the event was successfully published.
       * @private
       */
      function publishEventForPlugin(dispatchConfig, PluginModule, eventName) {
        ("production" !== "development" ? invariant(
          !EventPluginRegistry.eventNameDispatchConfigs.hasOwnProperty(eventName),
          'EventPluginHub: More than one plugin attempted to publish the same ' +
          'event name, `%s`.',
          eventName
        ) : invariant(!EventPluginRegistry.eventNameDispatchConfigs.hasOwnProperty(eventName)));
        EventPluginRegistry.eventNameDispatchConfigs[eventName] = dispatchConfig;
      
        var phasedRegistrationNames = dispatchConfig.phasedRegistrationNames;
        if (phasedRegistrationNames) {
          for (var phaseName in phasedRegistrationNames) {
            if (phasedRegistrationNames.hasOwnProperty(phaseName)) {
              var phasedRegistrationName = phasedRegistrationNames[phaseName];
              publishRegistrationName(
                phasedRegistrationName,
                PluginModule,
                eventName
              );
            }
          }
          return true;
        } else if (dispatchConfig.registrationName) {
          publishRegistrationName(
            dispatchConfig.registrationName,
            PluginModule,
            eventName
          );
          return true;
        }
        return false;
      }
      
      /**
       * Publishes a registration name that is used to identify dispatched events and
       * can be used with `EventPluginHub.putListener` to register listeners.
       *
       * @param {string} registrationName Registration name to add.
       * @param {object} PluginModule Plugin publishing the event.
       * @private
       */
      function publishRegistrationName(registrationName, PluginModule, eventName) {
        ("production" !== "development" ? invariant(
          !EventPluginRegistry.registrationNameModules[registrationName],
          'EventPluginHub: More than one plugin attempted to publish the same ' +
          'registration name, `%s`.',
          registrationName
        ) : invariant(!EventPluginRegistry.registrationNameModules[registrationName]));
        EventPluginRegistry.registrationNameModules[registrationName] = PluginModule;
        EventPluginRegistry.registrationNameDependencies[registrationName] =
          PluginModule.eventTypes[eventName].dependencies;
      }
      
      /**
       * Registers plugins so that they can extract and dispatch events.
       *
       * @see {EventPluginHub}
       */
      var EventPluginRegistry = {
      
        /**
         * Ordered list of injected plugins.
         */
        plugins: [],
      
        /**
         * Mapping from event name to dispatch config
         */
        eventNameDispatchConfigs: {},
      
        /**
         * Mapping from registration name to plugin module
         */
        registrationNameModules: {},
      
        /**
         * Mapping from registration name to event name
         */
        registrationNameDependencies: {},
      
        /**
         * Injects an ordering of plugins (by plugin name). This allows the ordering
         * to be decoupled from injection of the actual plugins so that ordering is
         * always deterministic regardless of packaging, on-the-fly injection, etc.
         *
         * @param {array} InjectedEventPluginOrder
         * @internal
         * @see {EventPluginHub.injection.injectEventPluginOrder}
         */
        injectEventPluginOrder: function(InjectedEventPluginOrder) {
          ("production" !== "development" ? invariant(
            !EventPluginOrder,
            'EventPluginRegistry: Cannot inject event plugin ordering more than ' +
            'once. You are likely trying to load more than one copy of React.'
          ) : invariant(!EventPluginOrder));
          // Clone the ordering so it cannot be dynamically mutated.
          EventPluginOrder = Array.prototype.slice.call(InjectedEventPluginOrder);
          recomputePluginOrdering();
        },
      
        /**
         * Injects plugins to be used by `EventPluginHub`. The plugin names must be
         * in the ordering injected by `injectEventPluginOrder`.
         *
         * Plugins can be injected as part of page initialization or on-the-fly.
         *
         * @param {object} injectedNamesToPlugins Map from names to plugin modules.
         * @internal
         * @see {EventPluginHub.injection.injectEventPluginsByName}
         */
        injectEventPluginsByName: function(injectedNamesToPlugins) {
          var isOrderingDirty = false;
          for (var pluginName in injectedNamesToPlugins) {
            if (!injectedNamesToPlugins.hasOwnProperty(pluginName)) {
              continue;
            }
            var PluginModule = injectedNamesToPlugins[pluginName];
            if (!namesToPlugins.hasOwnProperty(pluginName) ||
                namesToPlugins[pluginName] !== PluginModule) {
              ("production" !== "development" ? invariant(
                !namesToPlugins[pluginName],
                'EventPluginRegistry: Cannot inject two different event plugins ' +
                'using the same name, `%s`.',
                pluginName
              ) : invariant(!namesToPlugins[pluginName]));
              namesToPlugins[pluginName] = PluginModule;
              isOrderingDirty = true;
            }
          }
          if (isOrderingDirty) {
            recomputePluginOrdering();
          }
        },
      
        /**
         * Looks up the plugin for the supplied event.
         *
         * @param {object} event A synthetic event.
         * @return {?object} The plugin that created the supplied event.
         * @internal
         */
        getPluginModuleForEvent: function(event) {
          var dispatchConfig = event.dispatchConfig;
          if (dispatchConfig.registrationName) {
            return EventPluginRegistry.registrationNameModules[
              dispatchConfig.registrationName
            ] || null;
          }
          for (var phase in dispatchConfig.phasedRegistrationNames) {
            if (!dispatchConfig.phasedRegistrationNames.hasOwnProperty(phase)) {
              continue;
            }
            var PluginModule = EventPluginRegistry.registrationNameModules[
              dispatchConfig.phasedRegistrationNames[phase]
            ];
            if (PluginModule) {
              return PluginModule;
            }
          }
          return null;
        },
      
        /**
         * Exposed for unit testing.
         * @private
         */
        _resetEventPlugins: function() {
          EventPluginOrder = null;
          for (var pluginName in namesToPlugins) {
            if (namesToPlugins.hasOwnProperty(pluginName)) {
              delete namesToPlugins[pluginName];
            }
          }
          EventPluginRegistry.plugins.length = 0;
      
          var eventNameDispatchConfigs = EventPluginRegistry.eventNameDispatchConfigs;
          for (var eventName in eventNameDispatchConfigs) {
            if (eventNameDispatchConfigs.hasOwnProperty(eventName)) {
              delete eventNameDispatchConfigs[eventName];
            }
          }
      
          var registrationNameModules = EventPluginRegistry.registrationNameModules;
          for (var registrationName in registrationNameModules) {
            if (registrationNameModules.hasOwnProperty(registrationName)) {
              delete registrationNameModules[registrationName];
            }
          }
        }
      
      };
      
      module.exports = EventPluginRegistry;
      
      },{"./invariant":120}],19:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule EventPluginUtils
       */
      
      "use strict";
      
      var EventConstants = _dereq_("./EventConstants");
      
      var invariant = _dereq_("./invariant");
      
      /**
       * Injected dependencies:
       */
      
      /**
       * - `Mount`: [required] Module that can convert between React dom IDs and
       *   actual node references.
       */
      var injection = {
        Mount: null,
        injectMount: function(InjectedMount) {
          injection.Mount = InjectedMount;
          if ("production" !== "development") {
            ("production" !== "development" ? invariant(
              InjectedMount && InjectedMount.getNode,
              'EventPluginUtils.injection.injectMount(...): Injected Mount module ' +
              'is missing getNode.'
            ) : invariant(InjectedMount && InjectedMount.getNode));
          }
        }
      };
      
      var topLevelTypes = EventConstants.topLevelTypes;
      
      function isEndish(topLevelType) {
        return topLevelType === topLevelTypes.topMouseUp ||
               topLevelType === topLevelTypes.topTouchEnd ||
               topLevelType === topLevelTypes.topTouchCancel;
      }
      
      function isMoveish(topLevelType) {
        return topLevelType === topLevelTypes.topMouseMove ||
               topLevelType === topLevelTypes.topTouchMove;
      }
      function isStartish(topLevelType) {
        return topLevelType === topLevelTypes.topMouseDown ||
               topLevelType === topLevelTypes.topTouchStart;
      }
      
      
      var validateEventDispatches;
      if ("production" !== "development") {
        validateEventDispatches = function(event) {
          var dispatchListeners = event._dispatchListeners;
          var dispatchIDs = event._dispatchIDs;
      
          var listenersIsArr = Array.isArray(dispatchListeners);
          var idsIsArr = Array.isArray(dispatchIDs);
          var IDsLen = idsIsArr ? dispatchIDs.length : dispatchIDs ? 1 : 0;
          var listenersLen = listenersIsArr ?
            dispatchListeners.length :
            dispatchListeners ? 1 : 0;
      
          ("production" !== "development" ? invariant(
            idsIsArr === listenersIsArr && IDsLen === listenersLen,
            'EventPluginUtils: Invalid `event`.'
          ) : invariant(idsIsArr === listenersIsArr && IDsLen === listenersLen));
        };
      }
      
      /**
       * Invokes `cb(event, listener, id)`. Avoids using call if no scope is
       * provided. The `(listener,id)` pair effectively forms the "dispatch" but are
       * kept separate to conserve memory.
       */
      function forEachEventDispatch(event, cb) {
        var dispatchListeners = event._dispatchListeners;
        var dispatchIDs = event._dispatchIDs;
        if ("production" !== "development") {
          validateEventDispatches(event);
        }
        if (Array.isArray(dispatchListeners)) {
          for (var i = 0; i < dispatchListeners.length; i++) {
            if (event.isPropagationStopped()) {
              break;
            }
            // Listeners and IDs are two parallel arrays that are always in sync.
            cb(event, dispatchListeners[i], dispatchIDs[i]);
          }
        } else if (dispatchListeners) {
          cb(event, dispatchListeners, dispatchIDs);
        }
      }
      
      /**
       * Default implementation of PluginModule.executeDispatch().
       * @param {SyntheticEvent} SyntheticEvent to handle
       * @param {function} Application-level callback
       * @param {string} domID DOM id to pass to the callback.
       */
      function executeDispatch(event, listener, domID) {
        event.currentTarget = injection.Mount.getNode(domID);
        var returnValue = listener(event, domID);
        event.currentTarget = null;
        return returnValue;
      }
      
      /**
       * Standard/simple iteration through an event's collected dispatches.
       */
      function executeDispatchesInOrder(event, executeDispatch) {
        forEachEventDispatch(event, executeDispatch);
        event._dispatchListeners = null;
        event._dispatchIDs = null;
      }
      
      /**
       * Standard/simple iteration through an event's collected dispatches, but stops
       * at the first dispatch execution returning true, and returns that id.
       *
       * @return id of the first dispatch execution who's listener returns true, or
       * null if no listener returned true.
       */
      function executeDispatchesInOrderStopAtTrueImpl(event) {
        var dispatchListeners = event._dispatchListeners;
        var dispatchIDs = event._dispatchIDs;
        if ("production" !== "development") {
          validateEventDispatches(event);
        }
        if (Array.isArray(dispatchListeners)) {
          for (var i = 0; i < dispatchListeners.length; i++) {
            if (event.isPropagationStopped()) {
              break;
            }
            // Listeners and IDs are two parallel arrays that are always in sync.
            if (dispatchListeners[i](event, dispatchIDs[i])) {
              return dispatchIDs[i];
            }
          }
        } else if (dispatchListeners) {
          if (dispatchListeners(event, dispatchIDs)) {
            return dispatchIDs;
          }
        }
        return null;
      }
      
      /**
       * @see executeDispatchesInOrderStopAtTrueImpl
       */
      function executeDispatchesInOrderStopAtTrue(event) {
        var ret = executeDispatchesInOrderStopAtTrueImpl(event);
        event._dispatchIDs = null;
        event._dispatchListeners = null;
        return ret;
      }
      
      /**
       * Execution of a "direct" dispatch - there must be at most one dispatch
       * accumulated on the event or it is considered an error. It doesn't really make
       * sense for an event with multiple dispatches (bubbled) to keep track of the
       * return values at each dispatch execution, but it does tend to make sense when
       * dealing with "direct" dispatches.
       *
       * @return The return value of executing the single dispatch.
       */
      function executeDirectDispatch(event) {
        if ("production" !== "development") {
          validateEventDispatches(event);
        }
        var dispatchListener = event._dispatchListeners;
        var dispatchID = event._dispatchIDs;
        ("production" !== "development" ? invariant(
          !Array.isArray(dispatchListener),
          'executeDirectDispatch(...): Invalid `event`.'
        ) : invariant(!Array.isArray(dispatchListener)));
        var res = dispatchListener ?
          dispatchListener(event, dispatchID) :
          null;
        event._dispatchListeners = null;
        event._dispatchIDs = null;
        return res;
      }
      
      /**
       * @param {SyntheticEvent} event
       * @return {bool} True iff number of dispatches accumulated is greater than 0.
       */
      function hasDispatches(event) {
        return !!event._dispatchListeners;
      }
      
      /**
       * General utilities that are useful in creating custom Event Plugins.
       */
      var EventPluginUtils = {
        isEndish: isEndish,
        isMoveish: isMoveish,
        isStartish: isStartish,
      
        executeDirectDispatch: executeDirectDispatch,
        executeDispatch: executeDispatch,
        executeDispatchesInOrder: executeDispatchesInOrder,
        executeDispatchesInOrderStopAtTrue: executeDispatchesInOrderStopAtTrue,
        hasDispatches: hasDispatches,
        injection: injection,
        useTouchEvents: false
      };
      
      module.exports = EventPluginUtils;
      
      },{"./EventConstants":15,"./invariant":120}],20:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule EventPropagators
       */
      
      "use strict";
      
      var EventConstants = _dereq_("./EventConstants");
      var EventPluginHub = _dereq_("./EventPluginHub");
      
      var accumulate = _dereq_("./accumulate");
      var forEachAccumulated = _dereq_("./forEachAccumulated");
      
      var PropagationPhases = EventConstants.PropagationPhases;
      var getListener = EventPluginHub.getListener;
      
      /**
       * Some event types have a notion of different registration names for different
       * "phases" of propagation. This finds listeners by a given phase.
       */
      function listenerAtPhase(id, event, propagationPhase) {
        var registrationName =
          event.dispatchConfig.phasedRegistrationNames[propagationPhase];
        return getListener(id, registrationName);
      }
      
      /**
       * Tags a `SyntheticEvent` with dispatched listeners. Creating this function
       * here, allows us to not have to bind or create functions for each event.
       * Mutating the event's members allows us to not have to create a wrapping
       * "dispatch" object that pairs the event with the listener.
       */
      function accumulateDirectionalDispatches(domID, upwards, event) {
        if ("production" !== "development") {
          if (!domID) {
            throw new Error('Dispatching id must not be null');
          }
        }
        var phase = upwards ? PropagationPhases.bubbled : PropagationPhases.captured;
        var listener = listenerAtPhase(domID, event, phase);
        if (listener) {
          event._dispatchListeners = accumulate(event._dispatchListeners, listener);
          event._dispatchIDs = accumulate(event._dispatchIDs, domID);
        }
      }
      
      /**
       * Collect dispatches (must be entirely collected before dispatching - see unit
       * tests). Lazily allocate the array to conserve memory.  We must loop through
       * each event and perform the traversal for each one. We can not perform a
       * single traversal for the entire collection of events because each event may
       * have a different target.
       */
      function accumulateTwoPhaseDispatchesSingle(event) {
        if (event && event.dispatchConfig.phasedRegistrationNames) {
          EventPluginHub.injection.getInstanceHandle().traverseTwoPhase(
            event.dispatchMarker,
            accumulateDirectionalDispatches,
            event
          );
        }
      }
      
      
      /**
       * Accumulates without regard to direction, does not look for phased
       * registration names. Same as `accumulateDirectDispatchesSingle` but without
       * requiring that the `dispatchMarker` be the same as the dispatched ID.
       */
      function accumulateDispatches(id, ignoredDirection, event) {
        if (event && event.dispatchConfig.registrationName) {
          var registrationName = event.dispatchConfig.registrationName;
          var listener = getListener(id, registrationName);
          if (listener) {
            event._dispatchListeners = accumulate(event._dispatchListeners, listener);
            event._dispatchIDs = accumulate(event._dispatchIDs, id);
          }
        }
      }
      
      /**
       * Accumulates dispatches on an `SyntheticEvent`, but only for the
       * `dispatchMarker`.
       * @param {SyntheticEvent} event
       */
      function accumulateDirectDispatchesSingle(event) {
        if (event && event.dispatchConfig.registrationName) {
          accumulateDispatches(event.dispatchMarker, null, event);
        }
      }
      
      function accumulateTwoPhaseDispatches(events) {
        forEachAccumulated(events, accumulateTwoPhaseDispatchesSingle);
      }
      
      function accumulateEnterLeaveDispatches(leave, enter, fromID, toID) {
        EventPluginHub.injection.getInstanceHandle().traverseEnterLeave(
          fromID,
          toID,
          accumulateDispatches,
          leave,
          enter
        );
      }
      
      
      function accumulateDirectDispatches(events) {
        forEachAccumulated(events, accumulateDirectDispatchesSingle);
      }
      
      
      
      /**
       * A small set of propagation patterns, each of which will accept a small amount
       * of information, and generate a set of "dispatch ready event objects" - which
       * are sets of events that have already been annotated with a set of dispatched
       * listener functions/ids. The API is designed this way to discourage these
       * propagation strategies from actually executing the dispatches, since we
       * always want to collect the entire set of dispatches before executing event a
       * single one.
       *
       * @constructor EventPropagators
       */
      var EventPropagators = {
        accumulateTwoPhaseDispatches: accumulateTwoPhaseDispatches,
        accumulateDirectDispatches: accumulateDirectDispatches,
        accumulateEnterLeaveDispatches: accumulateEnterLeaveDispatches
      };
      
      module.exports = EventPropagators;
      
      },{"./EventConstants":15,"./EventPluginHub":17,"./accumulate":94,"./forEachAccumulated":107}],21:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ExecutionEnvironment
       */
      
      /*jslint evil: true */
      
      "use strict";
      
      var canUseDOM = !!(
        typeof window !== 'undefined' &&
        window.document &&
        window.document.createElement
      );
      
      /**
       * Simple, lightweight module assisting with the detection and context of
       * Worker. Helps avoid circular dependencies and allows code to reason about
       * whether or not they are in a Worker, even if they never include the main
       * `ReactWorker` dependency.
       */
      var ExecutionEnvironment = {
      
        canUseDOM: canUseDOM,
      
        canUseWorkers: typeof Worker !== 'undefined',
      
        canUseEventListeners:
          canUseDOM && !!(window.addEventListener || window.attachEvent),
      
        canUseViewport: canUseDOM && !!window.screen,
      
        isInWorker: !canUseDOM // For now, this is true - might change in the future.
      
      };
      
      module.exports = ExecutionEnvironment;
      
      },{}],22:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule HTMLDOMPropertyConfig
       */
      
      /*jslint bitwise: true*/
      
      "use strict";
      
      var DOMProperty = _dereq_("./DOMProperty");
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      
      var MUST_USE_ATTRIBUTE = DOMProperty.injection.MUST_USE_ATTRIBUTE;
      var MUST_USE_PROPERTY = DOMProperty.injection.MUST_USE_PROPERTY;
      var HAS_BOOLEAN_VALUE = DOMProperty.injection.HAS_BOOLEAN_VALUE;
      var HAS_SIDE_EFFECTS = DOMProperty.injection.HAS_SIDE_EFFECTS;
      var HAS_NUMERIC_VALUE = DOMProperty.injection.HAS_NUMERIC_VALUE;
      var HAS_POSITIVE_NUMERIC_VALUE =
        DOMProperty.injection.HAS_POSITIVE_NUMERIC_VALUE;
      var HAS_OVERLOADED_BOOLEAN_VALUE =
        DOMProperty.injection.HAS_OVERLOADED_BOOLEAN_VALUE;
      
      var hasSVG;
      if (ExecutionEnvironment.canUseDOM) {
        var implementation = document.implementation;
        hasSVG = (
          implementation &&
          implementation.hasFeature &&
          implementation.hasFeature(
            'http://www.w3.org/TR/SVG11/feature#BasicStructure',
            '1.1'
          )
        );
      }
      
      
      var HTMLDOMPropertyConfig = {
        isCustomAttribute: RegExp.prototype.test.bind(
          /^(data|aria)-[a-z_][a-z\d_.\-]*$/
        ),
        Properties: {
          /**
           * Standard Properties
           */
          accept: null,
          accessKey: null,
          action: null,
          allowFullScreen: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
          allowTransparency: MUST_USE_ATTRIBUTE,
          alt: null,
          async: HAS_BOOLEAN_VALUE,
          autoComplete: null,
          // autoFocus is polyfilled/normalized by AutoFocusMixin
          // autoFocus: HAS_BOOLEAN_VALUE,
          autoPlay: HAS_BOOLEAN_VALUE,
          cellPadding: null,
          cellSpacing: null,
          charSet: MUST_USE_ATTRIBUTE,
          checked: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
          // To set className on SVG elements, it's necessary to use .setAttribute;
          // this works on HTML elements too in all browsers except IE8. Conveniently,
          // IE8 doesn't support SVG and so we can simply use the attribute in
          // browsers that support SVG and the property in browsers that don't,
          // regardless of whether the element is HTML or SVG.
          className: hasSVG ? MUST_USE_ATTRIBUTE : MUST_USE_PROPERTY,
          cols: MUST_USE_ATTRIBUTE | HAS_POSITIVE_NUMERIC_VALUE,
          colSpan: null,
          content: null,
          contentEditable: null,
          contextMenu: MUST_USE_ATTRIBUTE,
          controls: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
          coords: null,
          crossOrigin: null,
          data: null, // For `<object />` acts as `src`.
          dateTime: MUST_USE_ATTRIBUTE,
          defer: HAS_BOOLEAN_VALUE,
          dir: null,
          disabled: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
          download: HAS_OVERLOADED_BOOLEAN_VALUE,
          draggable: null,
          encType: null,
          form: MUST_USE_ATTRIBUTE,
          formNoValidate: HAS_BOOLEAN_VALUE,
          frameBorder: MUST_USE_ATTRIBUTE,
          height: MUST_USE_ATTRIBUTE,
          hidden: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
          href: null,
          hrefLang: null,
          htmlFor: null,
          httpEquiv: null,
          icon: null,
          id: MUST_USE_PROPERTY,
          label: null,
          lang: null,
          list: null,
          loop: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
          max: null,
          maxLength: MUST_USE_ATTRIBUTE,
          media: MUST_USE_ATTRIBUTE,
          mediaGroup: null,
          method: null,
          min: null,
          multiple: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
          muted: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
          name: null,
          noValidate: HAS_BOOLEAN_VALUE,
          open: null,
          pattern: null,
          placeholder: null,
          poster: null,
          preload: null,
          radioGroup: null,
          readOnly: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
          rel: null,
          required: HAS_BOOLEAN_VALUE,
          role: MUST_USE_ATTRIBUTE,
          rows: MUST_USE_ATTRIBUTE | HAS_POSITIVE_NUMERIC_VALUE,
          rowSpan: null,
          sandbox: null,
          scope: null,
          scrollLeft: MUST_USE_PROPERTY,
          scrolling: null,
          scrollTop: MUST_USE_PROPERTY,
          seamless: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
          selected: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
          shape: null,
          size: MUST_USE_ATTRIBUTE | HAS_POSITIVE_NUMERIC_VALUE,
          sizes: MUST_USE_ATTRIBUTE,
          span: HAS_POSITIVE_NUMERIC_VALUE,
          spellCheck: null,
          src: null,
          srcDoc: MUST_USE_PROPERTY,
          srcSet: MUST_USE_ATTRIBUTE,
          start: HAS_NUMERIC_VALUE,
          step: null,
          style: null,
          tabIndex: null,
          target: null,
          title: null,
          type: null,
          useMap: null,
          value: MUST_USE_PROPERTY | HAS_SIDE_EFFECTS,
          width: MUST_USE_ATTRIBUTE,
          wmode: MUST_USE_ATTRIBUTE,
      
          /**
           * Non-standard Properties
           */
          autoCapitalize: null, // Supported in Mobile Safari for keyboard hints
          autoCorrect: null, // Supported in Mobile Safari for keyboard hints
          itemProp: MUST_USE_ATTRIBUTE, // Microdata: http://schema.org/docs/gs.html
          itemScope: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE, // Microdata: http://schema.org/docs/gs.html
          itemType: MUST_USE_ATTRIBUTE, // Microdata: http://schema.org/docs/gs.html
          property: null // Supports OG in meta tags
        },
        DOMAttributeNames: {
          className: 'class',
          htmlFor: 'for',
          httpEquiv: 'http-equiv'
        },
        DOMPropertyNames: {
          autoCapitalize: 'autocapitalize',
          autoComplete: 'autocomplete',
          autoCorrect: 'autocorrect',
          autoFocus: 'autofocus',
          autoPlay: 'autoplay',
          encType: 'enctype',
          hrefLang: 'hreflang',
          radioGroup: 'radiogroup',
          spellCheck: 'spellcheck',
          srcDoc: 'srcdoc',
          srcSet: 'srcset'
        }
      };
      
      module.exports = HTMLDOMPropertyConfig;
      
      },{"./DOMProperty":10,"./ExecutionEnvironment":21}],23:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule LinkedValueUtils
       * @typechecks static-only
       */
      
      "use strict";
      
      var ReactPropTypes = _dereq_("./ReactPropTypes");
      
      var invariant = _dereq_("./invariant");
      
      var hasReadOnlyValue = {
        'button': true,
        'checkbox': true,
        'image': true,
        'hidden': true,
        'radio': true,
        'reset': true,
        'submit': true
      };
      
      function _assertSingleLink(input) {
        ("production" !== "development" ? invariant(
          input.props.checkedLink == null || input.props.valueLink == null,
          'Cannot provide a checkedLink and a valueLink. If you want to use ' +
          'checkedLink, you probably don\'t want to use valueLink and vice versa.'
        ) : invariant(input.props.checkedLink == null || input.props.valueLink == null));
      }
      function _assertValueLink(input) {
        _assertSingleLink(input);
        ("production" !== "development" ? invariant(
          input.props.value == null && input.props.onChange == null,
          'Cannot provide a valueLink and a value or onChange event. If you want ' +
          'to use value or onChange, you probably don\'t want to use valueLink.'
        ) : invariant(input.props.value == null && input.props.onChange == null));
      }
      
      function _assertCheckedLink(input) {
        _assertSingleLink(input);
        ("production" !== "development" ? invariant(
          input.props.checked == null && input.props.onChange == null,
          'Cannot provide a checkedLink and a checked property or onChange event. ' +
          'If you want to use checked or onChange, you probably don\'t want to ' +
          'use checkedLink'
        ) : invariant(input.props.checked == null && input.props.onChange == null));
      }
      
      /**
       * @param {SyntheticEvent} e change event to handle
       */
      function _handleLinkedValueChange(e) {
        /*jshint validthis:true */
        this.props.valueLink.requestChange(e.target.value);
      }
      
      /**
        * @param {SyntheticEvent} e change event to handle
        */
      function _handleLinkedCheckChange(e) {
        /*jshint validthis:true */
        this.props.checkedLink.requestChange(e.target.checked);
      }
      
      /**
       * Provide a linked `value` attribute for controlled forms. You should not use
       * this outside of the ReactDOM controlled form components.
       */
      var LinkedValueUtils = {
        Mixin: {
          propTypes: {
            value: function(props, propName, componentName) {
              if (!props[propName] ||
                  hasReadOnlyValue[props.type] ||
                  props.onChange ||
                  props.readOnly ||
                  props.disabled) {
                return;
              }
              return new Error(
                'You provided a `value` prop to a form field without an ' +
                '`onChange` handler. This will render a read-only field. If ' +
                'the field should be mutable use `defaultValue`. Otherwise, ' +
                'set either `onChange` or `readOnly`.'
              );
            },
            checked: function(props, propName, componentName) {
              if (!props[propName] ||
                  props.onChange ||
                  props.readOnly ||
                  props.disabled) {
                return;
              }
              return new Error(
                'You provided a `checked` prop to a form field without an ' +
                '`onChange` handler. This will render a read-only field. If ' +
                'the field should be mutable use `defaultChecked`. Otherwise, ' +
                'set either `onChange` or `readOnly`.'
              );
            },
            onChange: ReactPropTypes.func
          }
        },
      
        /**
         * @param {ReactComponent} input Form component
         * @return {*} current value of the input either from value prop or link.
         */
        getValue: function(input) {
          if (input.props.valueLink) {
            _assertValueLink(input);
            return input.props.valueLink.value;
          }
          return input.props.value;
        },
      
        /**
         * @param {ReactComponent} input Form component
         * @return {*} current checked status of the input either from checked prop
         *             or link.
         */
        getChecked: function(input) {
          if (input.props.checkedLink) {
            _assertCheckedLink(input);
            return input.props.checkedLink.value;
          }
          return input.props.checked;
        },
      
        /**
         * @param {ReactComponent} input Form component
         * @return {function} change callback either from onChange prop or link.
         */
        getOnChange: function(input) {
          if (input.props.valueLink) {
            _assertValueLink(input);
            return _handleLinkedValueChange;
          } else if (input.props.checkedLink) {
            _assertCheckedLink(input);
            return _handleLinkedCheckChange;
          }
          return input.props.onChange;
        }
      };
      
      module.exports = LinkedValueUtils;
      
      },{"./ReactPropTypes":69,"./invariant":120}],24:[function(_dereq_,module,exports){
      /**
       * Copyright 2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule LocalEventTrapMixin
       */
      
      "use strict";
      
      var ReactBrowserEventEmitter = _dereq_("./ReactBrowserEventEmitter");
      
      var accumulate = _dereq_("./accumulate");
      var forEachAccumulated = _dereq_("./forEachAccumulated");
      var invariant = _dereq_("./invariant");
      
      function remove(event) {
        event.remove();
      }
      
      var LocalEventTrapMixin = {
        trapBubbledEvent:function(topLevelType, handlerBaseName) {
          ("production" !== "development" ? invariant(this.isMounted(), 'Must be mounted to trap events') : invariant(this.isMounted()));
          var listener = ReactBrowserEventEmitter.trapBubbledEvent(
            topLevelType,
            handlerBaseName,
            this.getDOMNode()
          );
          this._localEventListeners = accumulate(this._localEventListeners, listener);
        },
      
        // trapCapturedEvent would look nearly identical. We don't implement that
        // method because it isn't currently needed.
      
        componentWillUnmount:function() {
          if (this._localEventListeners) {
            forEachAccumulated(this._localEventListeners, remove);
          }
        }
      };
      
      module.exports = LocalEventTrapMixin;
      
      },{"./ReactBrowserEventEmitter":29,"./accumulate":94,"./forEachAccumulated":107,"./invariant":120}],25:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule MobileSafariClickEventPlugin
       * @typechecks static-only
       */
      
      "use strict";
      
      var EventConstants = _dereq_("./EventConstants");
      
      var emptyFunction = _dereq_("./emptyFunction");
      
      var topLevelTypes = EventConstants.topLevelTypes;
      
      /**
       * Mobile Safari does not fire properly bubble click events on non-interactive
       * elements, which means delegated click listeners do not fire. The workaround
       * for this bug involves attaching an empty click listener on the target node.
       *
       * This particular plugin works around the bug by attaching an empty click
       * listener on `touchstart` (which does fire on every element).
       */
      var MobileSafariClickEventPlugin = {
      
        eventTypes: null,
      
        /**
         * @param {string} topLevelType Record from `EventConstants`.
         * @param {DOMEventTarget} topLevelTarget The listening component root node.
         * @param {string} topLevelTargetID ID of `topLevelTarget`.
         * @param {object} nativeEvent Native browser event.
         * @return {*} An accumulation of synthetic events.
         * @see {EventPluginHub.extractEvents}
         */
        extractEvents: function(
            topLevelType,
            topLevelTarget,
            topLevelTargetID,
            nativeEvent) {
          if (topLevelType === topLevelTypes.topTouchStart) {
            var target = nativeEvent.target;
            if (target && !target.onclick) {
              target.onclick = emptyFunction;
            }
          }
        }
      
      };
      
      module.exports = MobileSafariClickEventPlugin;
      
      },{"./EventConstants":15,"./emptyFunction":102}],26:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule PooledClass
       */
      
      "use strict";
      
      var invariant = _dereq_("./invariant");
      
      /**
       * Static poolers. Several custom versions for each potential number of
       * arguments. A completely generic pooler is easy to implement, but would
       * require accessing the `arguments` object. In each of these, `this` refers to
       * the Class itself, not an instance. If any others are needed, simply add them
       * here, or in their own files.
       */
      var oneArgumentPooler = function(copyFieldsFrom) {
        var Klass = this;
        if (Klass.instancePool.length) {
          var instance = Klass.instancePool.pop();
          Klass.call(instance, copyFieldsFrom);
          return instance;
        } else {
          return new Klass(copyFieldsFrom);
        }
      };
      
      var twoArgumentPooler = function(a1, a2) {
        var Klass = this;
        if (Klass.instancePool.length) {
          var instance = Klass.instancePool.pop();
          Klass.call(instance, a1, a2);
          return instance;
        } else {
          return new Klass(a1, a2);
        }
      };
      
      var threeArgumentPooler = function(a1, a2, a3) {
        var Klass = this;
        if (Klass.instancePool.length) {
          var instance = Klass.instancePool.pop();
          Klass.call(instance, a1, a2, a3);
          return instance;
        } else {
          return new Klass(a1, a2, a3);
        }
      };
      
      var fiveArgumentPooler = function(a1, a2, a3, a4, a5) {
        var Klass = this;
        if (Klass.instancePool.length) {
          var instance = Klass.instancePool.pop();
          Klass.call(instance, a1, a2, a3, a4, a5);
          return instance;
        } else {
          return new Klass(a1, a2, a3, a4, a5);
        }
      };
      
      var standardReleaser = function(instance) {
        var Klass = this;
        ("production" !== "development" ? invariant(
          instance instanceof Klass,
          'Trying to release an instance into a pool of a different type.'
        ) : invariant(instance instanceof Klass));
        if (instance.destructor) {
          instance.destructor();
        }
        if (Klass.instancePool.length < Klass.poolSize) {
          Klass.instancePool.push(instance);
        }
      };
      
      var DEFAULT_POOL_SIZE = 10;
      var DEFAULT_POOLER = oneArgumentPooler;
      
      /**
       * Augments `CopyConstructor` to be a poolable class, augmenting only the class
       * itself (statically) not adding any prototypical fields. Any CopyConstructor
       * you give this may have a `poolSize` property, and will look for a
       * prototypical `destructor` on instances (optional).
       *
       * @param {Function} CopyConstructor Constructor that can be used to reset.
       * @param {Function} pooler Customizable pooler.
       */
      var addPoolingTo = function(CopyConstructor, pooler) {
        var NewKlass = CopyConstructor;
        NewKlass.instancePool = [];
        NewKlass.getPooled = pooler || DEFAULT_POOLER;
        if (!NewKlass.poolSize) {
          NewKlass.poolSize = DEFAULT_POOL_SIZE;
        }
        NewKlass.release = standardReleaser;
        return NewKlass;
      };
      
      var PooledClass = {
        addPoolingTo: addPoolingTo,
        oneArgumentPooler: oneArgumentPooler,
        twoArgumentPooler: twoArgumentPooler,
        threeArgumentPooler: threeArgumentPooler,
        fiveArgumentPooler: fiveArgumentPooler
      };
      
      module.exports = PooledClass;
      
      },{"./invariant":120}],27:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule React
       */
      
      "use strict";
      
      var DOMPropertyOperations = _dereq_("./DOMPropertyOperations");
      var EventPluginUtils = _dereq_("./EventPluginUtils");
      var ReactChildren = _dereq_("./ReactChildren");
      var ReactComponent = _dereq_("./ReactComponent");
      var ReactCompositeComponent = _dereq_("./ReactCompositeComponent");
      var ReactContext = _dereq_("./ReactContext");
      var ReactCurrentOwner = _dereq_("./ReactCurrentOwner");
      var ReactDescriptor = _dereq_("./ReactDescriptor");
      var ReactDOM = _dereq_("./ReactDOM");
      var ReactDOMComponent = _dereq_("./ReactDOMComponent");
      var ReactDefaultInjection = _dereq_("./ReactDefaultInjection");
      var ReactInstanceHandles = _dereq_("./ReactInstanceHandles");
      var ReactMount = _dereq_("./ReactMount");
      var ReactMultiChild = _dereq_("./ReactMultiChild");
      var ReactPerf = _dereq_("./ReactPerf");
      var ReactPropTypes = _dereq_("./ReactPropTypes");
      var ReactServerRendering = _dereq_("./ReactServerRendering");
      var ReactTextComponent = _dereq_("./ReactTextComponent");
      
      var onlyChild = _dereq_("./onlyChild");
      var warning = _dereq_("./warning");
      
      ReactDefaultInjection.inject();
      
      // Specifying arguments isn't necessary since we just use apply anyway, but it
      // makes it clear for those actually consuming this API.
      function createDescriptor(type, props, children) {
        var args = Array.prototype.slice.call(arguments, 1);
        return type.apply(null, args);
      }
      
      if ("production" !== "development") {
        var _warnedForDeprecation = false;
      }
      
      var React = {
        Children: {
          map: ReactChildren.map,
          forEach: ReactChildren.forEach,
          count: ReactChildren.count,
          only: onlyChild
        },
        DOM: ReactDOM,
        PropTypes: ReactPropTypes,
        initializeTouchEvents: function(shouldUseTouch) {
          EventPluginUtils.useTouchEvents = shouldUseTouch;
        },
        createClass: ReactCompositeComponent.createClass,
        createDescriptor: function() {
          if ("production" !== "development") {
            ("production" !== "development" ? warning(
              _warnedForDeprecation,
              'React.createDescriptor is deprecated and will be removed in the ' +
              'next version of React. Use React.createElement instead.'
            ) : null);
            _warnedForDeprecation = true;
          }
          return createDescriptor.apply(this, arguments);
        },
        createElement: createDescriptor,
        constructAndRenderComponent: ReactMount.constructAndRenderComponent,
        constructAndRenderComponentByID: ReactMount.constructAndRenderComponentByID,
        renderComponent: ReactPerf.measure(
          'React',
          'renderComponent',
          ReactMount.renderComponent
        ),
        renderComponentToString: ReactServerRendering.renderComponentToString,
        renderComponentToStaticMarkup:
          ReactServerRendering.renderComponentToStaticMarkup,
        unmountComponentAtNode: ReactMount.unmountComponentAtNode,
        isValidClass: ReactDescriptor.isValidFactory,
        isValidComponent: ReactDescriptor.isValidDescriptor,
        withContext: ReactContext.withContext,
        __internals: {
          Component: ReactComponent,
          CurrentOwner: ReactCurrentOwner,
          DOMComponent: ReactDOMComponent,
          DOMPropertyOperations: DOMPropertyOperations,
          InstanceHandles: ReactInstanceHandles,
          Mount: ReactMount,
          MultiChild: ReactMultiChild,
          TextComponent: ReactTextComponent
        }
      };
      
      if ("production" !== "development") {
        var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
        if (ExecutionEnvironment.canUseDOM &&
            window.top === window.self &&
            navigator.userAgent.indexOf('Chrome') > -1) {
          console.debug(
            'Download the React DevTools for a better development experience: ' +
            'http://fb.me/react-devtools'
          );
      
          var expectedFeatures = [
            // shims
            Array.isArray,
            Array.prototype.every,
            Array.prototype.forEach,
            Array.prototype.indexOf,
            Array.prototype.map,
            Date.now,
            Function.prototype.bind,
            Object.keys,
            String.prototype.split,
            String.prototype.trim,
      
            // shams
            Object.create,
            Object.freeze
          ];
      
          for (var i in expectedFeatures) {
            if (!expectedFeatures[i]) {
              console.error(
                'One or more ES5 shim/shams expected by React are not available: ' +
                'http://fb.me/react-warning-polyfills'
              );
              break;
            }
          }
        }
      }
      
      // Version exists only in the open-source version of React, not in Facebook's
      // internal version.
      React.version = '0.11.2';
      
      module.exports = React;
      
      },{"./DOMPropertyOperations":11,"./EventPluginUtils":19,"./ExecutionEnvironment":21,"./ReactChildren":30,"./ReactComponent":31,"./ReactCompositeComponent":33,"./ReactContext":34,"./ReactCurrentOwner":35,"./ReactDOM":36,"./ReactDOMComponent":38,"./ReactDefaultInjection":48,"./ReactDescriptor":51,"./ReactInstanceHandles":59,"./ReactMount":61,"./ReactMultiChild":62,"./ReactPerf":65,"./ReactPropTypes":69,"./ReactServerRendering":73,"./ReactTextComponent":75,"./onlyChild":135,"./warning":143}],28:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactBrowserComponentMixin
       */
      
      "use strict";
      
      var ReactEmptyComponent = _dereq_("./ReactEmptyComponent");
      var ReactMount = _dereq_("./ReactMount");
      
      var invariant = _dereq_("./invariant");
      
      var ReactBrowserComponentMixin = {
        /**
         * Returns the DOM node rendered by this component.
         *
         * @return {DOMElement} The root node of this component.
         * @final
         * @protected
         */
        getDOMNode: function() {
          ("production" !== "development" ? invariant(
            this.isMounted(),
            'getDOMNode(): A component must be mounted to have a DOM node.'
          ) : invariant(this.isMounted()));
          if (ReactEmptyComponent.isNullComponentID(this._rootNodeID)) {
            return null;
          }
          return ReactMount.getNode(this._rootNodeID);
        }
      };
      
      module.exports = ReactBrowserComponentMixin;
      
      },{"./ReactEmptyComponent":53,"./ReactMount":61,"./invariant":120}],29:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactBrowserEventEmitter
       * @typechecks static-only
       */
      
      "use strict";
      
      var EventConstants = _dereq_("./EventConstants");
      var EventPluginHub = _dereq_("./EventPluginHub");
      var EventPluginRegistry = _dereq_("./EventPluginRegistry");
      var ReactEventEmitterMixin = _dereq_("./ReactEventEmitterMixin");
      var ViewportMetrics = _dereq_("./ViewportMetrics");
      
      var isEventSupported = _dereq_("./isEventSupported");
      var merge = _dereq_("./merge");
      
      /**
       * Summary of `ReactBrowserEventEmitter` event handling:
       *
       *  - Top-level delegation is used to trap most native browser events. This
       *    may only occur in the main thread and is the responsibility of
       *    ReactEventListener, which is injected and can therefore support pluggable
       *    event sources. This is the only work that occurs in the main thread.
       *
       *  - We normalize and de-duplicate events to account for browser quirks. This
       *    may be done in the worker thread.
       *
       *  - Forward these native events (with the associated top-level type used to
       *    trap it) to `EventPluginHub`, which in turn will ask plugins if they want
       *    to extract any synthetic events.
       *
       *  - The `EventPluginHub` will then process each event by annotating them with
       *    "dispatches", a sequence of listeners and IDs that care about that event.
       *
       *  - The `EventPluginHub` then dispatches the events.
       *
       * Overview of React and the event system:
       *
       * +------------+    .
       * |    DOM     |    .
       * +------------+    .
       *       |           .
       *       v           .
       * +------------+    .
       * | ReactEvent |    .
       * |  Listener  |    .
       * +------------+    .                         +-----------+
       *       |           .               +--------+|SimpleEvent|
       *       |           .               |         |Plugin     |
       * +-----|------+    .               v         +-----------+
       * |     |      |    .    +--------------+                    +------------+
       * |     +-----------.--->|EventPluginHub|                    |    Event   |
       * |            |    .    |              |     +-----------+  | Propagators|
       * | ReactEvent |    .    |              |     |TapEvent   |  |------------|
       * |  Emitter   |    .    |              |<---+|Plugin     |  |other plugin|
       * |            |    .    |              |     +-----------+  |  utilities |
       * |     +-----------.--->|              |                    +------------+
       * |     |      |    .    +--------------+
       * +-----|------+    .                ^        +-----------+
       *       |           .                |        |Enter/Leave|
       *       +           .                +-------+|Plugin     |
       * +-------------+   .                         +-----------+
       * | application |   .
       * |-------------|   .
       * |             |   .
       * |             |   .
       * +-------------+   .
       *                   .
       *    React Core     .  General Purpose Event Plugin System
       */
      
      var alreadyListeningTo = {};
      var isMonitoringScrollValue = false;
      var reactTopListenersCounter = 0;
      
      // For events like 'submit' which don't consistently bubble (which we trap at a
      // lower node than `document`), binding at `document` would cause duplicate
      // events so we don't include them here
      var topEventMapping = {
        topBlur: 'blur',
        topChange: 'change',
        topClick: 'click',
        topCompositionEnd: 'compositionend',
        topCompositionStart: 'compositionstart',
        topCompositionUpdate: 'compositionupdate',
        topContextMenu: 'contextmenu',
        topCopy: 'copy',
        topCut: 'cut',
        topDoubleClick: 'dblclick',
        topDrag: 'drag',
        topDragEnd: 'dragend',
        topDragEnter: 'dragenter',
        topDragExit: 'dragexit',
        topDragLeave: 'dragleave',
        topDragOver: 'dragover',
        topDragStart: 'dragstart',
        topDrop: 'drop',
        topFocus: 'focus',
        topInput: 'input',
        topKeyDown: 'keydown',
        topKeyPress: 'keypress',
        topKeyUp: 'keyup',
        topMouseDown: 'mousedown',
        topMouseMove: 'mousemove',
        topMouseOut: 'mouseout',
        topMouseOver: 'mouseover',
        topMouseUp: 'mouseup',
        topPaste: 'paste',
        topScroll: 'scroll',
        topSelectionChange: 'selectionchange',
        topTextInput: 'textInput',
        topTouchCancel: 'touchcancel',
        topTouchEnd: 'touchend',
        topTouchMove: 'touchmove',
        topTouchStart: 'touchstart',
        topWheel: 'wheel'
      };
      
      /**
       * To ensure no conflicts with other potential React instances on the page
       */
      var topListenersIDKey = "_reactListenersID" + String(Math.random()).slice(2);
      
      function getListeningForDocument(mountAt) {
        // In IE8, `mountAt` is a host object and doesn't have `hasOwnProperty`
        // directly.
        if (!Object.prototype.hasOwnProperty.call(mountAt, topListenersIDKey)) {
          mountAt[topListenersIDKey] = reactTopListenersCounter++;
          alreadyListeningTo[mountAt[topListenersIDKey]] = {};
        }
        return alreadyListeningTo[mountAt[topListenersIDKey]];
      }
      
      /**
       * `ReactBrowserEventEmitter` is used to attach top-level event listeners. For
       * example:
       *
       *   ReactBrowserEventEmitter.putListener('myID', 'onClick', myFunction);
       *
       * This would allocate a "registration" of `('onClick', myFunction)` on 'myID'.
       *
       * @internal
       */
      var ReactBrowserEventEmitter = merge(ReactEventEmitterMixin, {
      
        /**
         * Injectable event backend
         */
        ReactEventListener: null,
      
        injection: {
          /**
           * @param {object} ReactEventListener
           */
          injectReactEventListener: function(ReactEventListener) {
            ReactEventListener.setHandleTopLevel(
              ReactBrowserEventEmitter.handleTopLevel
            );
            ReactBrowserEventEmitter.ReactEventListener = ReactEventListener;
          }
        },
      
        /**
         * Sets whether or not any created callbacks should be enabled.
         *
         * @param {boolean} enabled True if callbacks should be enabled.
         */
        setEnabled: function(enabled) {
          if (ReactBrowserEventEmitter.ReactEventListener) {
            ReactBrowserEventEmitter.ReactEventListener.setEnabled(enabled);
          }
        },
      
        /**
         * @return {boolean} True if callbacks are enabled.
         */
        isEnabled: function() {
          return !!(
            ReactBrowserEventEmitter.ReactEventListener &&
            ReactBrowserEventEmitter.ReactEventListener.isEnabled()
          );
        },
      
        /**
         * We listen for bubbled touch events on the document object.
         *
         * Firefox v8.01 (and possibly others) exhibited strange behavior when
         * mounting `onmousemove` events at some node that was not the document
         * element. The symptoms were that if your mouse is not moving over something
         * contained within that mount point (for example on the background) the
         * top-level listeners for `onmousemove` won't be called. However, if you
         * register the `mousemove` on the document object, then it will of course
         * catch all `mousemove`s. This along with iOS quirks, justifies restricting
         * top-level listeners to the document object only, at least for these
         * movement types of events and possibly all events.
         *
         * @see http://www.quirksmode.org/blog/archives/2010/09/click_event_del.html
         *
         * Also, `keyup`/`keypress`/`keydown` do not bubble to the window on IE, but
         * they bubble to document.
         *
         * @param {string} registrationName Name of listener (e.g. `onClick`).
         * @param {object} contentDocumentHandle Document which owns the container
         */
        listenTo: function(registrationName, contentDocumentHandle) {
          var mountAt = contentDocumentHandle;
          var isListening = getListeningForDocument(mountAt);
          var dependencies = EventPluginRegistry.
            registrationNameDependencies[registrationName];
      
          var topLevelTypes = EventConstants.topLevelTypes;
          for (var i = 0, l = dependencies.length; i < l; i++) {
            var dependency = dependencies[i];
            if (!(
                  isListening.hasOwnProperty(dependency) &&
                  isListening[dependency]
                )) {
              if (dependency === topLevelTypes.topWheel) {
                if (isEventSupported('wheel')) {
                  ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
                    topLevelTypes.topWheel,
                    'wheel',
                    mountAt
                  );
                } else if (isEventSupported('mousewheel')) {
                  ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
                    topLevelTypes.topWheel,
                    'mousewheel',
                    mountAt
                  );
                } else {
                  // Firefox needs to capture a different mouse scroll event.
                  // @see http://www.quirksmode.org/dom/events/tests/scroll.html
                  ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
                    topLevelTypes.topWheel,
                    'DOMMouseScroll',
                    mountAt
                  );
                }
              } else if (dependency === topLevelTypes.topScroll) {
      
                if (isEventSupported('scroll', true)) {
                  ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(
                    topLevelTypes.topScroll,
                    'scroll',
                    mountAt
                  );
                } else {
                  ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
                    topLevelTypes.topScroll,
                    'scroll',
                    ReactBrowserEventEmitter.ReactEventListener.WINDOW_HANDLE
                  );
                }
              } else if (dependency === topLevelTypes.topFocus ||
                  dependency === topLevelTypes.topBlur) {
      
                if (isEventSupported('focus', true)) {
                  ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(
                    topLevelTypes.topFocus,
                    'focus',
                    mountAt
                  );
                  ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(
                    topLevelTypes.topBlur,
                    'blur',
                    mountAt
                  );
                } else if (isEventSupported('focusin')) {
                  // IE has `focusin` and `focusout` events which bubble.
                  // @see http://www.quirksmode.org/blog/archives/2008/04/delegating_the.html
                  ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
                    topLevelTypes.topFocus,
                    'focusin',
                    mountAt
                  );
                  ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
                    topLevelTypes.topBlur,
                    'focusout',
                    mountAt
                  );
                }
      
                // to make sure blur and focus event listeners are only attached once
                isListening[topLevelTypes.topBlur] = true;
                isListening[topLevelTypes.topFocus] = true;
              } else if (topEventMapping.hasOwnProperty(dependency)) {
                ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
                  dependency,
                  topEventMapping[dependency],
                  mountAt
                );
              }
      
              isListening[dependency] = true;
            }
          }
        },
      
        trapBubbledEvent: function(topLevelType, handlerBaseName, handle) {
          return ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
            topLevelType,
            handlerBaseName,
            handle
          );
        },
      
        trapCapturedEvent: function(topLevelType, handlerBaseName, handle) {
          return ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(
            topLevelType,
            handlerBaseName,
            handle
          );
        },
      
        /**
         * Listens to window scroll and resize events. We cache scroll values so that
         * application code can access them without triggering reflows.
         *
         * NOTE: Scroll events do not bubble.
         *
         * @see http://www.quirksmode.org/dom/events/scroll.html
         */
        ensureScrollValueMonitoring: function(){
          if (!isMonitoringScrollValue) {
            var refresh = ViewportMetrics.refreshScrollValues;
            ReactBrowserEventEmitter.ReactEventListener.monitorScrollValue(refresh);
            isMonitoringScrollValue = true;
          }
        },
      
        eventNameDispatchConfigs: EventPluginHub.eventNameDispatchConfigs,
      
        registrationNameModules: EventPluginHub.registrationNameModules,
      
        putListener: EventPluginHub.putListener,
      
        getListener: EventPluginHub.getListener,
      
        deleteListener: EventPluginHub.deleteListener,
      
        deleteAllListeners: EventPluginHub.deleteAllListeners
      
      });
      
      module.exports = ReactBrowserEventEmitter;
      
      },{"./EventConstants":15,"./EventPluginHub":17,"./EventPluginRegistry":18,"./ReactEventEmitterMixin":55,"./ViewportMetrics":93,"./isEventSupported":121,"./merge":130}],30:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactChildren
       */
      
      "use strict";
      
      var PooledClass = _dereq_("./PooledClass");
      
      var traverseAllChildren = _dereq_("./traverseAllChildren");
      var warning = _dereq_("./warning");
      
      var twoArgumentPooler = PooledClass.twoArgumentPooler;
      var threeArgumentPooler = PooledClass.threeArgumentPooler;
      
      /**
       * PooledClass representing the bookkeeping associated with performing a child
       * traversal. Allows avoiding binding callbacks.
       *
       * @constructor ForEachBookKeeping
       * @param {!function} forEachFunction Function to perform traversal with.
       * @param {?*} forEachContext Context to perform context with.
       */
      function ForEachBookKeeping(forEachFunction, forEachContext) {
        this.forEachFunction = forEachFunction;
        this.forEachContext = forEachContext;
      }
      PooledClass.addPoolingTo(ForEachBookKeeping, twoArgumentPooler);
      
      function forEachSingleChild(traverseContext, child, name, i) {
        var forEachBookKeeping = traverseContext;
        forEachBookKeeping.forEachFunction.call(
          forEachBookKeeping.forEachContext, child, i);
      }
      
      /**
       * Iterates through children that are typically specified as `props.children`.
       *
       * The provided forEachFunc(child, index) will be called for each
       * leaf child.
       *
       * @param {?*} children Children tree container.
       * @param {function(*, int)} forEachFunc.
       * @param {*} forEachContext Context for forEachContext.
       */
      function forEachChildren(children, forEachFunc, forEachContext) {
        if (children == null) {
          return children;
        }
      
        var traverseContext =
          ForEachBookKeeping.getPooled(forEachFunc, forEachContext);
        traverseAllChildren(children, forEachSingleChild, traverseContext);
        ForEachBookKeeping.release(traverseContext);
      }
      
      /**
       * PooledClass representing the bookkeeping associated with performing a child
       * mapping. Allows avoiding binding callbacks.
       *
       * @constructor MapBookKeeping
       * @param {!*} mapResult Object containing the ordered map of results.
       * @param {!function} mapFunction Function to perform mapping with.
       * @param {?*} mapContext Context to perform mapping with.
       */
      function MapBookKeeping(mapResult, mapFunction, mapContext) {
        this.mapResult = mapResult;
        this.mapFunction = mapFunction;
        this.mapContext = mapContext;
      }
      PooledClass.addPoolingTo(MapBookKeeping, threeArgumentPooler);
      
      function mapSingleChildIntoContext(traverseContext, child, name, i) {
        var mapBookKeeping = traverseContext;
        var mapResult = mapBookKeeping.mapResult;
      
        var keyUnique = !mapResult.hasOwnProperty(name);
        ("production" !== "development" ? warning(
          keyUnique,
          'ReactChildren.map(...): Encountered two children with the same key, ' +
          '`%s`. Child keys must be unique; when two children share a key, only ' +
          'the first child will be used.',
          name
        ) : null);
      
        if (keyUnique) {
          var mappedChild =
            mapBookKeeping.mapFunction.call(mapBookKeeping.mapContext, child, i);
          mapResult[name] = mappedChild;
        }
      }
      
      /**
       * Maps children that are typically specified as `props.children`.
       *
       * The provided mapFunction(child, key, index) will be called for each
       * leaf child.
       *
       * TODO: This may likely break any calls to `ReactChildren.map` that were
       * previously relying on the fact that we guarded against null children.
       *
       * @param {?*} children Children tree container.
       * @param {function(*, int)} mapFunction.
       * @param {*} mapContext Context for mapFunction.
       * @return {object} Object containing the ordered map of results.
       */
      function mapChildren(children, func, context) {
        if (children == null) {
          return children;
        }
      
        var mapResult = {};
        var traverseContext = MapBookKeeping.getPooled(mapResult, func, context);
        traverseAllChildren(children, mapSingleChildIntoContext, traverseContext);
        MapBookKeeping.release(traverseContext);
        return mapResult;
      }
      
      function forEachSingleChildDummy(traverseContext, child, name, i) {
        return null;
      }
      
      /**
       * Count the number of children that are typically specified as
       * `props.children`.
       *
       * @param {?*} children Children tree container.
       * @return {number} The number of children.
       */
      function countChildren(children, context) {
        return traverseAllChildren(children, forEachSingleChildDummy, null);
      }
      
      var ReactChildren = {
        forEach: forEachChildren,
        map: mapChildren,
        count: countChildren
      };
      
      module.exports = ReactChildren;
      
      },{"./PooledClass":26,"./traverseAllChildren":142,"./warning":143}],31:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactComponent
       */
      
      "use strict";
      
      var ReactDescriptor = _dereq_("./ReactDescriptor");
      var ReactOwner = _dereq_("./ReactOwner");
      var ReactUpdates = _dereq_("./ReactUpdates");
      
      var invariant = _dereq_("./invariant");
      var keyMirror = _dereq_("./keyMirror");
      var merge = _dereq_("./merge");
      
      /**
       * Every React component is in one of these life cycles.
       */
      var ComponentLifeCycle = keyMirror({
        /**
         * Mounted components have a DOM node representation and are capable of
         * receiving new props.
         */
        MOUNTED: null,
        /**
         * Unmounted components are inactive and cannot receive new props.
         */
        UNMOUNTED: null
      });
      
      var injected = false;
      
      /**
       * Optionally injectable environment dependent cleanup hook. (server vs.
       * browser etc). Example: A browser system caches DOM nodes based on component
       * ID and must remove that cache entry when this instance is unmounted.
       *
       * @private
       */
      var unmountIDFromEnvironment = null;
      
      /**
       * The "image" of a component tree, is the platform specific (typically
       * serialized) data that represents a tree of lower level UI building blocks.
       * On the web, this "image" is HTML markup which describes a construction of
       * low level `div` and `span` nodes. Other platforms may have different
       * encoding of this "image". This must be injected.
       *
       * @private
       */
      var mountImageIntoNode = null;
      
      /**
       * Components are the basic units of composition in React.
       *
       * Every component accepts a set of keyed input parameters known as "props" that
       * are initialized by the constructor. Once a component is mounted, the props
       * can be mutated using `setProps` or `replaceProps`.
       *
       * Every component is capable of the following operations:
       *
       *   `mountComponent`
       *     Initializes the component, renders markup, and registers event listeners.
       *
       *   `receiveComponent`
       *     Updates the rendered DOM nodes to match the given component.
       *
       *   `unmountComponent`
       *     Releases any resources allocated by this component.
       *
       * Components can also be "owned" by other components. Being owned by another
       * component means being constructed by that component. This is different from
       * being the child of a component, which means having a DOM representation that
       * is a child of the DOM representation of that component.
       *
       * @class ReactComponent
       */
      var ReactComponent = {
      
        injection: {
          injectEnvironment: function(ReactComponentEnvironment) {
            ("production" !== "development" ? invariant(
              !injected,
              'ReactComponent: injectEnvironment() can only be called once.'
            ) : invariant(!injected));
            mountImageIntoNode = ReactComponentEnvironment.mountImageIntoNode;
            unmountIDFromEnvironment =
              ReactComponentEnvironment.unmountIDFromEnvironment;
            ReactComponent.BackendIDOperations =
              ReactComponentEnvironment.BackendIDOperations;
            injected = true;
          }
        },
      
        /**
         * @internal
         */
        LifeCycle: ComponentLifeCycle,
      
        /**
         * Injected module that provides ability to mutate individual properties.
         * Injected into the base class because many different subclasses need access
         * to this.
         *
         * @internal
         */
        BackendIDOperations: null,
      
        /**
         * Base functionality for every ReactComponent constructor. Mixed into the
         * `ReactComponent` prototype, but exposed statically for easy access.
         *
         * @lends {ReactComponent.prototype}
         */
        Mixin: {
      
          /**
           * Checks whether or not this component is mounted.
           *
           * @return {boolean} True if mounted, false otherwise.
           * @final
           * @protected
           */
          isMounted: function() {
            return this._lifeCycleState === ComponentLifeCycle.MOUNTED;
          },
      
          /**
           * Sets a subset of the props.
           *
           * @param {object} partialProps Subset of the next props.
           * @param {?function} callback Called after props are updated.
           * @final
           * @public
           */
          setProps: function(partialProps, callback) {
            // Merge with the pending descriptor if it exists, otherwise with existing
            // descriptor props.
            var descriptor = this._pendingDescriptor || this._descriptor;
            this.replaceProps(
              merge(descriptor.props, partialProps),
              callback
            );
          },
      
          /**
           * Replaces all of the props.
           *
           * @param {object} props New props.
           * @param {?function} callback Called after props are updated.
           * @final
           * @public
           */
          replaceProps: function(props, callback) {
            ("production" !== "development" ? invariant(
              this.isMounted(),
              'replaceProps(...): Can only update a mounted component.'
            ) : invariant(this.isMounted()));
            ("production" !== "development" ? invariant(
              this._mountDepth === 0,
              'replaceProps(...): You called `setProps` or `replaceProps` on a ' +
              'component with a parent. This is an anti-pattern since props will ' +
              'get reactively updated when rendered. Instead, change the owner\'s ' +
              '`render` method to pass the correct value as props to the component ' +
              'where it is created.'
            ) : invariant(this._mountDepth === 0));
            // This is a deoptimized path. We optimize for always having a descriptor.
            // This creates an extra internal descriptor.
            this._pendingDescriptor = ReactDescriptor.cloneAndReplaceProps(
              this._pendingDescriptor || this._descriptor,
              props
            );
            ReactUpdates.enqueueUpdate(this, callback);
          },
      
          /**
           * Schedule a partial update to the props. Only used for internal testing.
           *
           * @param {object} partialProps Subset of the next props.
           * @param {?function} callback Called after props are updated.
           * @final
           * @internal
           */
          _setPropsInternal: function(partialProps, callback) {
            // This is a deoptimized path. We optimize for always having a descriptor.
            // This creates an extra internal descriptor.
            var descriptor = this._pendingDescriptor || this._descriptor;
            this._pendingDescriptor = ReactDescriptor.cloneAndReplaceProps(
              descriptor,
              merge(descriptor.props, partialProps)
            );
            ReactUpdates.enqueueUpdate(this, callback);
          },
      
          /**
           * Base constructor for all React components.
           *
           * Subclasses that override this method should make sure to invoke
           * `ReactComponent.Mixin.construct.call(this, ...)`.
           *
           * @param {ReactDescriptor} descriptor
           * @internal
           */
          construct: function(descriptor) {
            // This is the public exposed props object after it has been processed
            // with default props. The descriptor's props represents the true internal
            // state of the props.
            this.props = descriptor.props;
            // Record the component responsible for creating this component.
            // This is accessible through the descriptor but we maintain an extra
            // field for compatibility with devtools and as a way to make an
            // incremental update. TODO: Consider deprecating this field.
            this._owner = descriptor._owner;
      
            // All components start unmounted.
            this._lifeCycleState = ComponentLifeCycle.UNMOUNTED;
      
            // See ReactUpdates.
            this._pendingCallbacks = null;
      
            // We keep the old descriptor and a reference to the pending descriptor
            // to track updates.
            this._descriptor = descriptor;
            this._pendingDescriptor = null;
          },
      
          /**
           * Initializes the component, renders markup, and registers event listeners.
           *
           * NOTE: This does not insert any nodes into the DOM.
           *
           * Subclasses that override this method should make sure to invoke
           * `ReactComponent.Mixin.mountComponent.call(this, ...)`.
           *
           * @param {string} rootID DOM ID of the root node.
           * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
           * @param {number} mountDepth number of components in the owner hierarchy.
           * @return {?string} Rendered markup to be inserted into the DOM.
           * @internal
           */
          mountComponent: function(rootID, transaction, mountDepth) {
            ("production" !== "development" ? invariant(
              !this.isMounted(),
              'mountComponent(%s, ...): Can only mount an unmounted component. ' +
              'Make sure to avoid storing components between renders or reusing a ' +
              'single component instance in multiple places.',
              rootID
            ) : invariant(!this.isMounted()));
            var props = this._descriptor.props;
            if (props.ref != null) {
              var owner = this._descriptor._owner;
              ReactOwner.addComponentAsRefTo(this, props.ref, owner);
            }
            this._rootNodeID = rootID;
            this._lifeCycleState = ComponentLifeCycle.MOUNTED;
            this._mountDepth = mountDepth;
            // Effectively: return '';
          },
      
          /**
           * Releases any resources allocated by `mountComponent`.
           *
           * NOTE: This does not remove any nodes from the DOM.
           *
           * Subclasses that override this method should make sure to invoke
           * `ReactComponent.Mixin.unmountComponent.call(this)`.
           *
           * @internal
           */
          unmountComponent: function() {
            ("production" !== "development" ? invariant(
              this.isMounted(),
              'unmountComponent(): Can only unmount a mounted component.'
            ) : invariant(this.isMounted()));
            var props = this.props;
            if (props.ref != null) {
              ReactOwner.removeComponentAsRefFrom(this, props.ref, this._owner);
            }
            unmountIDFromEnvironment(this._rootNodeID);
            this._rootNodeID = null;
            this._lifeCycleState = ComponentLifeCycle.UNMOUNTED;
          },
      
          /**
           * Given a new instance of this component, updates the rendered DOM nodes
           * as if that instance was rendered instead.
           *
           * Subclasses that override this method should make sure to invoke
           * `ReactComponent.Mixin.receiveComponent.call(this, ...)`.
           *
           * @param {object} nextComponent Next set of properties.
           * @param {ReactReconcileTransaction} transaction
           * @internal
           */
          receiveComponent: function(nextDescriptor, transaction) {
            ("production" !== "development" ? invariant(
              this.isMounted(),
              'receiveComponent(...): Can only update a mounted component.'
            ) : invariant(this.isMounted()));
            this._pendingDescriptor = nextDescriptor;
            this.performUpdateIfNecessary(transaction);
          },
      
          /**
           * If `_pendingDescriptor` is set, update the component.
           *
           * @param {ReactReconcileTransaction} transaction
           * @internal
           */
          performUpdateIfNecessary: function(transaction) {
            if (this._pendingDescriptor == null) {
              return;
            }
            var prevDescriptor = this._descriptor;
            var nextDescriptor = this._pendingDescriptor;
            this._descriptor = nextDescriptor;
            this.props = nextDescriptor.props;
            this._owner = nextDescriptor._owner;
            this._pendingDescriptor = null;
            this.updateComponent(transaction, prevDescriptor);
          },
      
          /**
           * Updates the component's currently mounted representation.
           *
           * @param {ReactReconcileTransaction} transaction
           * @param {object} prevDescriptor
           * @internal
           */
          updateComponent: function(transaction, prevDescriptor) {
            var nextDescriptor = this._descriptor;
      
            // If either the owner or a `ref` has changed, make sure the newest owner
            // has stored a reference to `this`, and the previous owner (if different)
            // has forgotten the reference to `this`. We use the descriptor instead
            // of the public this.props because the post processing cannot determine
            // a ref. The ref conceptually lives on the descriptor.
      
            // TODO: Should this even be possible? The owner cannot change because
            // it's forbidden by shouldUpdateReactComponent. The ref can change
            // if you swap the keys of but not the refs. Reconsider where this check
            // is made. It probably belongs where the key checking and
            // instantiateReactComponent is done.
      
            if (nextDescriptor._owner !== prevDescriptor._owner ||
                nextDescriptor.props.ref !== prevDescriptor.props.ref) {
              if (prevDescriptor.props.ref != null) {
                ReactOwner.removeComponentAsRefFrom(
                  this, prevDescriptor.props.ref, prevDescriptor._owner
                );
              }
              // Correct, even if the owner is the same, and only the ref has changed.
              if (nextDescriptor.props.ref != null) {
                ReactOwner.addComponentAsRefTo(
                  this,
                  nextDescriptor.props.ref,
                  nextDescriptor._owner
                );
              }
            }
          },
      
          /**
           * Mounts this component and inserts it into the DOM.
           *
           * @param {string} rootID DOM ID of the root node.
           * @param {DOMElement} container DOM element to mount into.
           * @param {boolean} shouldReuseMarkup If true, do not insert markup
           * @final
           * @internal
           * @see {ReactMount.renderComponent}
           */
          mountComponentIntoNode: function(rootID, container, shouldReuseMarkup) {
            var transaction = ReactUpdates.ReactReconcileTransaction.getPooled();
            transaction.perform(
              this._mountComponentIntoNode,
              this,
              rootID,
              container,
              transaction,
              shouldReuseMarkup
            );
            ReactUpdates.ReactReconcileTransaction.release(transaction);
          },
      
          /**
           * @param {string} rootID DOM ID of the root node.
           * @param {DOMElement} container DOM element to mount into.
           * @param {ReactReconcileTransaction} transaction
           * @param {boolean} shouldReuseMarkup If true, do not insert markup
           * @final
           * @private
           */
          _mountComponentIntoNode: function(
              rootID,
              container,
              transaction,
              shouldReuseMarkup) {
            var markup = this.mountComponent(rootID, transaction, 0);
            mountImageIntoNode(markup, container, shouldReuseMarkup);
          },
      
          /**
           * Checks if this component is owned by the supplied `owner` component.
           *
           * @param {ReactComponent} owner Component to check.
           * @return {boolean} True if `owners` owns this component.
           * @final
           * @internal
           */
          isOwnedBy: function(owner) {
            return this._owner === owner;
          },
      
          /**
           * Gets another component, that shares the same owner as this one, by ref.
           *
           * @param {string} ref of a sibling Component.
           * @return {?ReactComponent} the actual sibling Component.
           * @final
           * @internal
           */
          getSiblingByRef: function(ref) {
            var owner = this._owner;
            if (!owner || !owner.refs) {
              return null;
            }
            return owner.refs[ref];
          }
        }
      };
      
      module.exports = ReactComponent;
      
      },{"./ReactDescriptor":51,"./ReactOwner":64,"./ReactUpdates":76,"./invariant":120,"./keyMirror":126,"./merge":130}],32:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactComponentBrowserEnvironment
       */
      
      /*jslint evil: true */
      
      "use strict";
      
      var ReactDOMIDOperations = _dereq_("./ReactDOMIDOperations");
      var ReactMarkupChecksum = _dereq_("./ReactMarkupChecksum");
      var ReactMount = _dereq_("./ReactMount");
      var ReactPerf = _dereq_("./ReactPerf");
      var ReactReconcileTransaction = _dereq_("./ReactReconcileTransaction");
      
      var getReactRootElementInContainer = _dereq_("./getReactRootElementInContainer");
      var invariant = _dereq_("./invariant");
      var setInnerHTML = _dereq_("./setInnerHTML");
      
      
      var ELEMENT_NODE_TYPE = 1;
      var DOC_NODE_TYPE = 9;
      
      
      /**
       * Abstracts away all functionality of `ReactComponent` requires knowledge of
       * the browser context.
       */
      var ReactComponentBrowserEnvironment = {
        ReactReconcileTransaction: ReactReconcileTransaction,
      
        BackendIDOperations: ReactDOMIDOperations,
      
        /**
         * If a particular environment requires that some resources be cleaned up,
         * specify this in the injected Mixin. In the DOM, we would likely want to
         * purge any cached node ID lookups.
         *
         * @private
         */
        unmountIDFromEnvironment: function(rootNodeID) {
          ReactMount.purgeID(rootNodeID);
        },
      
        /**
         * @param {string} markup Markup string to place into the DOM Element.
         * @param {DOMElement} container DOM Element to insert markup into.
         * @param {boolean} shouldReuseMarkup Should reuse the existing markup in the
         * container if possible.
         */
        mountImageIntoNode: ReactPerf.measure(
          'ReactComponentBrowserEnvironment',
          'mountImageIntoNode',
          function(markup, container, shouldReuseMarkup) {
            ("production" !== "development" ? invariant(
              container && (
                container.nodeType === ELEMENT_NODE_TYPE ||
                  container.nodeType === DOC_NODE_TYPE
              ),
              'mountComponentIntoNode(...): Target container is not valid.'
            ) : invariant(container && (
              container.nodeType === ELEMENT_NODE_TYPE ||
                container.nodeType === DOC_NODE_TYPE
            )));
      
            if (shouldReuseMarkup) {
              if (ReactMarkupChecksum.canReuseMarkup(
                markup,
                getReactRootElementInContainer(container))) {
                return;
              } else {
                ("production" !== "development" ? invariant(
                  container.nodeType !== DOC_NODE_TYPE,
                  'You\'re trying to render a component to the document using ' +
                  'server rendering but the checksum was invalid. This usually ' +
                  'means you rendered a different component type or props on ' +
                  'the client from the one on the server, or your render() ' +
                  'methods are impure. React cannot handle this case due to ' +
                  'cross-browser quirks by rendering at the document root. You ' +
                  'should look for environment dependent code in your components ' +
                  'and ensure the props are the same client and server side.'
                ) : invariant(container.nodeType !== DOC_NODE_TYPE));
      
                if ("production" !== "development") {
                  console.warn(
                    'React attempted to use reuse markup in a container but the ' +
                    'checksum was invalid. This generally means that you are ' +
                    'using server rendering and the markup generated on the ' +
                    'server was not what the client was expecting. React injected ' +
                    'new markup to compensate which works but you have lost many ' +
                    'of the benefits of server rendering. Instead, figure out ' +
                    'why the markup being generated is different on the client ' +
                    'or server.'
                  );
                }
              }
            }
      
            ("production" !== "development" ? invariant(
              container.nodeType !== DOC_NODE_TYPE,
              'You\'re trying to render a component to the document but ' +
                'you didn\'t use server rendering. We can\'t do this ' +
                'without using server rendering due to cross-browser quirks. ' +
                'See renderComponentToString() for server rendering.'
            ) : invariant(container.nodeType !== DOC_NODE_TYPE));
      
            setInnerHTML(container, markup);
          }
        )
      };
      
      module.exports = ReactComponentBrowserEnvironment;
      
      },{"./ReactDOMIDOperations":40,"./ReactMarkupChecksum":60,"./ReactMount":61,"./ReactPerf":65,"./ReactReconcileTransaction":71,"./getReactRootElementInContainer":114,"./invariant":120,"./setInnerHTML":138}],33:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactCompositeComponent
       */
      
      "use strict";
      
      var ReactComponent = _dereq_("./ReactComponent");
      var ReactContext = _dereq_("./ReactContext");
      var ReactCurrentOwner = _dereq_("./ReactCurrentOwner");
      var ReactDescriptor = _dereq_("./ReactDescriptor");
      var ReactDescriptorValidator = _dereq_("./ReactDescriptorValidator");
      var ReactEmptyComponent = _dereq_("./ReactEmptyComponent");
      var ReactErrorUtils = _dereq_("./ReactErrorUtils");
      var ReactOwner = _dereq_("./ReactOwner");
      var ReactPerf = _dereq_("./ReactPerf");
      var ReactPropTransferer = _dereq_("./ReactPropTransferer");
      var ReactPropTypeLocations = _dereq_("./ReactPropTypeLocations");
      var ReactPropTypeLocationNames = _dereq_("./ReactPropTypeLocationNames");
      var ReactUpdates = _dereq_("./ReactUpdates");
      
      var instantiateReactComponent = _dereq_("./instantiateReactComponent");
      var invariant = _dereq_("./invariant");
      var keyMirror = _dereq_("./keyMirror");
      var merge = _dereq_("./merge");
      var mixInto = _dereq_("./mixInto");
      var monitorCodeUse = _dereq_("./monitorCodeUse");
      var mapObject = _dereq_("./mapObject");
      var shouldUpdateReactComponent = _dereq_("./shouldUpdateReactComponent");
      var warning = _dereq_("./warning");
      
      /**
       * Policies that describe methods in `ReactCompositeComponentInterface`.
       */
      var SpecPolicy = keyMirror({
        /**
         * These methods may be defined only once by the class specification or mixin.
         */
        DEFINE_ONCE: null,
        /**
         * These methods may be defined by both the class specification and mixins.
         * Subsequent definitions will be chained. These methods must return void.
         */
        DEFINE_MANY: null,
        /**
         * These methods are overriding the base ReactCompositeComponent class.
         */
        OVERRIDE_BASE: null,
        /**
         * These methods are similar to DEFINE_MANY, except we assume they return
         * objects. We try to merge the keys of the return values of all the mixed in
         * functions. If there is a key conflict we throw.
         */
        DEFINE_MANY_MERGED: null
      });
      
      
      var injectedMixins = [];
      
      /**
       * Composite components are higher-level components that compose other composite
       * or native components.
       *
       * To create a new type of `ReactCompositeComponent`, pass a specification of
       * your new class to `React.createClass`. The only requirement of your class
       * specification is that you implement a `render` method.
       *
       *   var MyComponent = React.createClass({
       *     render: function() {
       *       return <div>Hello World</div>;
       *     }
       *   });
       *
       * The class specification supports a specific protocol of methods that have
       * special meaning (e.g. `render`). See `ReactCompositeComponentInterface` for
       * more the comprehensive protocol. Any other properties and methods in the
       * class specification will available on the prototype.
       *
       * @interface ReactCompositeComponentInterface
       * @internal
       */
      var ReactCompositeComponentInterface = {
      
        /**
         * An array of Mixin objects to include when defining your component.
         *
         * @type {array}
         * @optional
         */
        mixins: SpecPolicy.DEFINE_MANY,
      
        /**
         * An object containing properties and methods that should be defined on
         * the component's constructor instead of its prototype (static methods).
         *
         * @type {object}
         * @optional
         */
        statics: SpecPolicy.DEFINE_MANY,
      
        /**
         * Definition of prop types for this component.
         *
         * @type {object}
         * @optional
         */
        propTypes: SpecPolicy.DEFINE_MANY,
      
        /**
         * Definition of context types for this component.
         *
         * @type {object}
         * @optional
         */
        contextTypes: SpecPolicy.DEFINE_MANY,
      
        /**
         * Definition of context types this component sets for its children.
         *
         * @type {object}
         * @optional
         */
        childContextTypes: SpecPolicy.DEFINE_MANY,
      
        // ==== Definition methods ====
      
        /**
         * Invoked when the component is mounted. Values in the mapping will be set on
         * `this.props` if that prop is not specified (i.e. using an `in` check).
         *
         * This method is invoked before `getInitialState` and therefore cannot rely
         * on `this.state` or use `this.setState`.
         *
         * @return {object}
         * @optional
         */
        getDefaultProps: SpecPolicy.DEFINE_MANY_MERGED,
      
        /**
         * Invoked once before the component is mounted. The return value will be used
         * as the initial value of `this.state`.
         *
         *   getInitialState: function() {
         *     return {
         *       isOn: false,
         *       fooBaz: new BazFoo()
         *     }
         *   }
         *
         * @return {object}
         * @optional
         */
        getInitialState: SpecPolicy.DEFINE_MANY_MERGED,
      
        /**
         * @return {object}
         * @optional
         */
        getChildContext: SpecPolicy.DEFINE_MANY_MERGED,
      
        /**
         * Uses props from `this.props` and state from `this.state` to render the
         * structure of the component.
         *
         * No guarantees are made about when or how often this method is invoked, so
         * it must not have side effects.
         *
         *   render: function() {
         *     var name = this.props.name;
         *     return <div>Hello, {name}!</div>;
         *   }
         *
         * @return {ReactComponent}
         * @nosideeffects
         * @required
         */
        render: SpecPolicy.DEFINE_ONCE,
      
      
      
        // ==== Delegate methods ====
      
        /**
         * Invoked when the component is initially created and about to be mounted.
         * This may have side effects, but any external subscriptions or data created
         * by this method must be cleaned up in `componentWillUnmount`.
         *
         * @optional
         */
        componentWillMount: SpecPolicy.DEFINE_MANY,
      
        /**
         * Invoked when the component has been mounted and has a DOM representation.
         * However, there is no guarantee that the DOM node is in the document.
         *
         * Use this as an opportunity to operate on the DOM when the component has
         * been mounted (initialized and rendered) for the first time.
         *
         * @param {DOMElement} rootNode DOM element representing the component.
         * @optional
         */
        componentDidMount: SpecPolicy.DEFINE_MANY,
      
        /**
         * Invoked before the component receives new props.
         *
         * Use this as an opportunity to react to a prop transition by updating the
         * state using `this.setState`. Current props are accessed via `this.props`.
         *
         *   componentWillReceiveProps: function(nextProps, nextContext) {
         *     this.setState({
         *       likesIncreasing: nextProps.likeCount > this.props.likeCount
         *     });
         *   }
         *
         * NOTE: There is no equivalent `componentWillReceiveState`. An incoming prop
         * transition may cause a state change, but the opposite is not true. If you
         * need it, you are probably looking for `componentWillUpdate`.
         *
         * @param {object} nextProps
         * @optional
         */
        componentWillReceiveProps: SpecPolicy.DEFINE_MANY,
      
        /**
         * Invoked while deciding if the component should be updated as a result of
         * receiving new props, state and/or context.
         *
         * Use this as an opportunity to `return false` when you're certain that the
         * transition to the new props/state/context will not require a component
         * update.
         *
         *   shouldComponentUpdate: function(nextProps, nextState, nextContext) {
         *     return !equal(nextProps, this.props) ||
         *       !equal(nextState, this.state) ||
         *       !equal(nextContext, this.context);
         *   }
         *
         * @param {object} nextProps
         * @param {?object} nextState
         * @param {?object} nextContext
         * @return {boolean} True if the component should update.
         * @optional
         */
        shouldComponentUpdate: SpecPolicy.DEFINE_ONCE,
      
        /**
         * Invoked when the component is about to update due to a transition from
         * `this.props`, `this.state` and `this.context` to `nextProps`, `nextState`
         * and `nextContext`.
         *
         * Use this as an opportunity to perform preparation before an update occurs.
         *
         * NOTE: You **cannot** use `this.setState()` in this method.
         *
         * @param {object} nextProps
         * @param {?object} nextState
         * @param {?object} nextContext
         * @param {ReactReconcileTransaction} transaction
         * @optional
         */
        componentWillUpdate: SpecPolicy.DEFINE_MANY,
      
        /**
         * Invoked when the component's DOM representation has been updated.
         *
         * Use this as an opportunity to operate on the DOM when the component has
         * been updated.
         *
         * @param {object} prevProps
         * @param {?object} prevState
         * @param {?object} prevContext
         * @param {DOMElement} rootNode DOM element representing the component.
         * @optional
         */
        componentDidUpdate: SpecPolicy.DEFINE_MANY,
      
        /**
         * Invoked when the component is about to be removed from its parent and have
         * its DOM representation destroyed.
         *
         * Use this as an opportunity to deallocate any external resources.
         *
         * NOTE: There is no `componentDidUnmount` since your component will have been
         * destroyed by that point.
         *
         * @optional
         */
        componentWillUnmount: SpecPolicy.DEFINE_MANY,
      
      
      
        // ==== Advanced methods ====
      
        /**
         * Updates the component's currently mounted DOM representation.
         *
         * By default, this implements React's rendering and reconciliation algorithm.
         * Sophisticated clients may wish to override this.
         *
         * @param {ReactReconcileTransaction} transaction
         * @internal
         * @overridable
         */
        updateComponent: SpecPolicy.OVERRIDE_BASE
      
      };
      
      /**
       * Mapping from class specification keys to special processing functions.
       *
       * Although these are declared like instance properties in the specification
       * when defining classes using `React.createClass`, they are actually static
       * and are accessible on the constructor instead of the prototype. Despite
       * being static, they must be defined outside of the "statics" key under
       * which all other static methods are defined.
       */
      var RESERVED_SPEC_KEYS = {
        displayName: function(Constructor, displayName) {
          Constructor.displayName = displayName;
        },
        mixins: function(Constructor, mixins) {
          if (mixins) {
            for (var i = 0; i < mixins.length; i++) {
              mixSpecIntoComponent(Constructor, mixins[i]);
            }
          }
        },
        childContextTypes: function(Constructor, childContextTypes) {
          validateTypeDef(
            Constructor,
            childContextTypes,
            ReactPropTypeLocations.childContext
          );
          Constructor.childContextTypes = merge(
            Constructor.childContextTypes,
            childContextTypes
          );
        },
        contextTypes: function(Constructor, contextTypes) {
          validateTypeDef(
            Constructor,
            contextTypes,
            ReactPropTypeLocations.context
          );
          Constructor.contextTypes = merge(Constructor.contextTypes, contextTypes);
        },
        /**
         * Special case getDefaultProps which should move into statics but requires
         * automatic merging.
         */
        getDefaultProps: function(Constructor, getDefaultProps) {
          if (Constructor.getDefaultProps) {
            Constructor.getDefaultProps = createMergedResultFunction(
              Constructor.getDefaultProps,
              getDefaultProps
            );
          } else {
            Constructor.getDefaultProps = getDefaultProps;
          }
        },
        propTypes: function(Constructor, propTypes) {
          validateTypeDef(
            Constructor,
            propTypes,
            ReactPropTypeLocations.prop
          );
          Constructor.propTypes = merge(Constructor.propTypes, propTypes);
        },
        statics: function(Constructor, statics) {
          mixStaticSpecIntoComponent(Constructor, statics);
        }
      };
      
      function getDeclarationErrorAddendum(component) {
        var owner = component._owner || null;
        if (owner && owner.constructor && owner.constructor.displayName) {
          return ' Check the render method of `' + owner.constructor.displayName +
            '`.';
        }
        return '';
      }
      
      function validateTypeDef(Constructor, typeDef, location) {
        for (var propName in typeDef) {
          if (typeDef.hasOwnProperty(propName)) {
            ("production" !== "development" ? invariant(
              typeof typeDef[propName] == 'function',
              '%s: %s type `%s` is invalid; it must be a function, usually from ' +
              'React.PropTypes.',
              Constructor.displayName || 'ReactCompositeComponent',
              ReactPropTypeLocationNames[location],
              propName
            ) : invariant(typeof typeDef[propName] == 'function'));
          }
        }
      }
      
      function validateMethodOverride(proto, name) {
        var specPolicy = ReactCompositeComponentInterface.hasOwnProperty(name) ?
          ReactCompositeComponentInterface[name] :
          null;
      
        // Disallow overriding of base class methods unless explicitly allowed.
        if (ReactCompositeComponentMixin.hasOwnProperty(name)) {
          ("production" !== "development" ? invariant(
            specPolicy === SpecPolicy.OVERRIDE_BASE,
            'ReactCompositeComponentInterface: You are attempting to override ' +
            '`%s` from your class specification. Ensure that your method names ' +
            'do not overlap with React methods.',
            name
          ) : invariant(specPolicy === SpecPolicy.OVERRIDE_BASE));
        }
      
        // Disallow defining methods more than once unless explicitly allowed.
        if (proto.hasOwnProperty(name)) {
          ("production" !== "development" ? invariant(
            specPolicy === SpecPolicy.DEFINE_MANY ||
            specPolicy === SpecPolicy.DEFINE_MANY_MERGED,
            'ReactCompositeComponentInterface: You are attempting to define ' +
            '`%s` on your component more than once. This conflict may be due ' +
            'to a mixin.',
            name
          ) : invariant(specPolicy === SpecPolicy.DEFINE_MANY ||
          specPolicy === SpecPolicy.DEFINE_MANY_MERGED));
        }
      }
      
      function validateLifeCycleOnReplaceState(instance) {
        var compositeLifeCycleState = instance._compositeLifeCycleState;
        ("production" !== "development" ? invariant(
          instance.isMounted() ||
            compositeLifeCycleState === CompositeLifeCycle.MOUNTING,
          'replaceState(...): Can only update a mounted or mounting component.'
        ) : invariant(instance.isMounted() ||
          compositeLifeCycleState === CompositeLifeCycle.MOUNTING));
        ("production" !== "development" ? invariant(compositeLifeCycleState !== CompositeLifeCycle.RECEIVING_STATE,
          'replaceState(...): Cannot update during an existing state transition ' +
          '(such as within `render`). This could potentially cause an infinite ' +
          'loop so it is forbidden.'
        ) : invariant(compositeLifeCycleState !== CompositeLifeCycle.RECEIVING_STATE));
        ("production" !== "development" ? invariant(compositeLifeCycleState !== CompositeLifeCycle.UNMOUNTING,
          'replaceState(...): Cannot update while unmounting component. This ' +
          'usually means you called setState() on an unmounted component.'
        ) : invariant(compositeLifeCycleState !== CompositeLifeCycle.UNMOUNTING));
      }
      
      /**
       * Custom version of `mixInto` which handles policy validation and reserved
       * specification keys when building `ReactCompositeComponent` classses.
       */
      function mixSpecIntoComponent(Constructor, spec) {
        ("production" !== "development" ? invariant(
          !ReactDescriptor.isValidFactory(spec),
          'ReactCompositeComponent: You\'re attempting to ' +
          'use a component class as a mixin. Instead, just use a regular object.'
        ) : invariant(!ReactDescriptor.isValidFactory(spec)));
        ("production" !== "development" ? invariant(
          !ReactDescriptor.isValidDescriptor(spec),
          'ReactCompositeComponent: You\'re attempting to ' +
          'use a component as a mixin. Instead, just use a regular object.'
        ) : invariant(!ReactDescriptor.isValidDescriptor(spec)));
      
        var proto = Constructor.prototype;
        for (var name in spec) {
          var property = spec[name];
          if (!spec.hasOwnProperty(name)) {
            continue;
          }
      
          validateMethodOverride(proto, name);
      
          if (RESERVED_SPEC_KEYS.hasOwnProperty(name)) {
            RESERVED_SPEC_KEYS[name](Constructor, property);
          } else {
            // Setup methods on prototype:
            // The following member methods should not be automatically bound:
            // 1. Expected ReactCompositeComponent methods (in the "interface").
            // 2. Overridden methods (that were mixed in).
            var isCompositeComponentMethod =
              ReactCompositeComponentInterface.hasOwnProperty(name);
            var isAlreadyDefined = proto.hasOwnProperty(name);
            var markedDontBind = property && property.__reactDontBind;
            var isFunction = typeof property === 'function';
            var shouldAutoBind =
              isFunction &&
              !isCompositeComponentMethod &&
              !isAlreadyDefined &&
              !markedDontBind;
      
            if (shouldAutoBind) {
              if (!proto.__reactAutoBindMap) {
                proto.__reactAutoBindMap = {};
              }
              proto.__reactAutoBindMap[name] = property;
              proto[name] = property;
            } else {
              if (isAlreadyDefined) {
                var specPolicy = ReactCompositeComponentInterface[name];
      
                // These cases should already be caught by validateMethodOverride
                ("production" !== "development" ? invariant(
                  isCompositeComponentMethod && (
                    specPolicy === SpecPolicy.DEFINE_MANY_MERGED ||
                    specPolicy === SpecPolicy.DEFINE_MANY
                  ),
                  'ReactCompositeComponent: Unexpected spec policy %s for key %s ' +
                  'when mixing in component specs.',
                  specPolicy,
                  name
                ) : invariant(isCompositeComponentMethod && (
                  specPolicy === SpecPolicy.DEFINE_MANY_MERGED ||
                  specPolicy === SpecPolicy.DEFINE_MANY
                )));
      
                // For methods which are defined more than once, call the existing
                // methods before calling the new property, merging if appropriate.
                if (specPolicy === SpecPolicy.DEFINE_MANY_MERGED) {
                  proto[name] = createMergedResultFunction(proto[name], property);
                } else if (specPolicy === SpecPolicy.DEFINE_MANY) {
                  proto[name] = createChainedFunction(proto[name], property);
                }
              } else {
                proto[name] = property;
                if ("production" !== "development") {
                  // Add verbose displayName to the function, which helps when looking
                  // at profiling tools.
                  if (typeof property === 'function' && spec.displayName) {
                    proto[name].displayName = spec.displayName + '_' + name;
                  }
                }
              }
            }
          }
        }
      }
      
      function mixStaticSpecIntoComponent(Constructor, statics) {
        if (!statics) {
          return;
        }
        for (var name in statics) {
          var property = statics[name];
          if (!statics.hasOwnProperty(name)) {
            continue;
          }
      
          var isInherited = name in Constructor;
          var result = property;
          if (isInherited) {
            var existingProperty = Constructor[name];
            var existingType = typeof existingProperty;
            var propertyType = typeof property;
            ("production" !== "development" ? invariant(
              existingType === 'function' && propertyType === 'function',
              'ReactCompositeComponent: You are attempting to define ' +
              '`%s` on your component more than once, but that is only supported ' +
              'for functions, which are chained together. This conflict may be ' +
              'due to a mixin.',
              name
            ) : invariant(existingType === 'function' && propertyType === 'function'));
            result = createChainedFunction(existingProperty, property);
          }
          Constructor[name] = result;
        }
      }
      
      /**
       * Merge two objects, but throw if both contain the same key.
       *
       * @param {object} one The first object, which is mutated.
       * @param {object} two The second object
       * @return {object} one after it has been mutated to contain everything in two.
       */
      function mergeObjectsWithNoDuplicateKeys(one, two) {
        ("production" !== "development" ? invariant(
          one && two && typeof one === 'object' && typeof two === 'object',
          'mergeObjectsWithNoDuplicateKeys(): Cannot merge non-objects'
        ) : invariant(one && two && typeof one === 'object' && typeof two === 'object'));
      
        mapObject(two, function(value, key) {
          ("production" !== "development" ? invariant(
            one[key] === undefined,
            'mergeObjectsWithNoDuplicateKeys(): ' +
            'Tried to merge two objects with the same key: %s',
            key
          ) : invariant(one[key] === undefined));
          one[key] = value;
        });
        return one;
      }
      
      /**
       * Creates a function that invokes two functions and merges their return values.
       *
       * @param {function} one Function to invoke first.
       * @param {function} two Function to invoke second.
       * @return {function} Function that invokes the two argument functions.
       * @private
       */
      function createMergedResultFunction(one, two) {
        return function mergedResult() {
          var a = one.apply(this, arguments);
          var b = two.apply(this, arguments);
          if (a == null) {
            return b;
          } else if (b == null) {
            return a;
          }
          return mergeObjectsWithNoDuplicateKeys(a, b);
        };
      }
      
      /**
       * Creates a function that invokes two functions and ignores their return vales.
       *
       * @param {function} one Function to invoke first.
       * @param {function} two Function to invoke second.
       * @return {function} Function that invokes the two argument functions.
       * @private
       */
      function createChainedFunction(one, two) {
        return function chainedFunction() {
          one.apply(this, arguments);
          two.apply(this, arguments);
        };
      }
      
      /**
       * `ReactCompositeComponent` maintains an auxiliary life cycle state in
       * `this._compositeLifeCycleState` (which can be null).
       *
       * This is different from the life cycle state maintained by `ReactComponent` in
       * `this._lifeCycleState`. The following diagram shows how the states overlap in
       * time. There are times when the CompositeLifeCycle is null - at those times it
       * is only meaningful to look at ComponentLifeCycle alone.
       *
       * Top Row: ReactComponent.ComponentLifeCycle
       * Low Row: ReactComponent.CompositeLifeCycle
       *
       * +-------+------------------------------------------------------+--------+
       * |  UN   |                    MOUNTED                           |   UN   |
       * |MOUNTED|                                                      | MOUNTED|
       * +-------+------------------------------------------------------+--------+
       * |       ^--------+   +------+   +------+   +------+   +--------^        |
       * |       |        |   |      |   |      |   |      |   |        |        |
       * |    0--|MOUNTING|-0-|RECEIV|-0-|RECEIV|-0-|RECEIV|-0-|   UN   |--->0   |
       * |       |        |   |PROPS |   | PROPS|   | STATE|   |MOUNTING|        |
       * |       |        |   |      |   |      |   |      |   |        |        |
       * |       |        |   |      |   |      |   |      |   |        |        |
       * |       +--------+   +------+   +------+   +------+   +--------+        |
       * |       |                                                      |        |
       * +-------+------------------------------------------------------+--------+
       */
      var CompositeLifeCycle = keyMirror({
        /**
         * Components in the process of being mounted respond to state changes
         * differently.
         */
        MOUNTING: null,
        /**
         * Components in the process of being unmounted are guarded against state
         * changes.
         */
        UNMOUNTING: null,
        /**
         * Components that are mounted and receiving new props respond to state
         * changes differently.
         */
        RECEIVING_PROPS: null,
        /**
         * Components that are mounted and receiving new state are guarded against
         * additional state changes.
         */
        RECEIVING_STATE: null
      });
      
      /**
       * @lends {ReactCompositeComponent.prototype}
       */
      var ReactCompositeComponentMixin = {
      
        /**
         * Base constructor for all composite component.
         *
         * @param {ReactDescriptor} descriptor
         * @final
         * @internal
         */
        construct: function(descriptor) {
          // Children can be either an array or more than one argument
          ReactComponent.Mixin.construct.apply(this, arguments);
          ReactOwner.Mixin.construct.apply(this, arguments);
      
          this.state = null;
          this._pendingState = null;
      
          // This is the public post-processed context. The real context and pending
          // context lives on the descriptor.
          this.context = null;
      
          this._compositeLifeCycleState = null;
        },
      
        /**
         * Checks whether or not this composite component is mounted.
         * @return {boolean} True if mounted, false otherwise.
         * @protected
         * @final
         */
        isMounted: function() {
          return ReactComponent.Mixin.isMounted.call(this) &&
            this._compositeLifeCycleState !== CompositeLifeCycle.MOUNTING;
        },
      
        /**
         * Initializes the component, renders markup, and registers event listeners.
         *
         * @param {string} rootID DOM ID of the root node.
         * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
         * @param {number} mountDepth number of components in the owner hierarchy
         * @return {?string} Rendered markup to be inserted into the DOM.
         * @final
         * @internal
         */
        mountComponent: ReactPerf.measure(
          'ReactCompositeComponent',
          'mountComponent',
          function(rootID, transaction, mountDepth) {
            ReactComponent.Mixin.mountComponent.call(
              this,
              rootID,
              transaction,
              mountDepth
            );
            this._compositeLifeCycleState = CompositeLifeCycle.MOUNTING;
      
            if (this.__reactAutoBindMap) {
              this._bindAutoBindMethods();
            }
      
            this.context = this._processContext(this._descriptor._context);
            this.props = this._processProps(this.props);
      
            this.state = this.getInitialState ? this.getInitialState() : null;
            ("production" !== "development" ? invariant(
              typeof this.state === 'object' && !Array.isArray(this.state),
              '%s.getInitialState(): must return an object or null',
              this.constructor.displayName || 'ReactCompositeComponent'
            ) : invariant(typeof this.state === 'object' && !Array.isArray(this.state)));
      
            this._pendingState = null;
            this._pendingForceUpdate = false;
      
            if (this.componentWillMount) {
              this.componentWillMount();
              // When mounting, calls to `setState` by `componentWillMount` will set
              // `this._pendingState` without triggering a re-render.
              if (this._pendingState) {
                this.state = this._pendingState;
                this._pendingState = null;
              }
            }
      
            this._renderedComponent = instantiateReactComponent(
              this._renderValidatedComponent()
            );
      
            // Done with mounting, `setState` will now trigger UI changes.
            this._compositeLifeCycleState = null;
            var markup = this._renderedComponent.mountComponent(
              rootID,
              transaction,
              mountDepth + 1
            );
            if (this.componentDidMount) {
              transaction.getReactMountReady().enqueue(this.componentDidMount, this);
            }
            return markup;
          }
        ),
      
        /**
         * Releases any resources allocated by `mountComponent`.
         *
         * @final
         * @internal
         */
        unmountComponent: function() {
          this._compositeLifeCycleState = CompositeLifeCycle.UNMOUNTING;
          if (this.componentWillUnmount) {
            this.componentWillUnmount();
          }
          this._compositeLifeCycleState = null;
      
          this._renderedComponent.unmountComponent();
          this._renderedComponent = null;
      
          ReactComponent.Mixin.unmountComponent.call(this);
      
          // Some existing components rely on this.props even after they've been
          // destroyed (in event handlers).
          // TODO: this.props = null;
          // TODO: this.state = null;
        },
      
        /**
         * Sets a subset of the state. Always use this or `replaceState` to mutate
         * state. You should treat `this.state` as immutable.
         *
         * There is no guarantee that `this.state` will be immediately updated, so
         * accessing `this.state` after calling this method may return the old value.
         *
         * There is no guarantee that calls to `setState` will run synchronously,
         * as they may eventually be batched together.  You can provide an optional
         * callback that will be executed when the call to setState is actually
         * completed.
         *
         * @param {object} partialState Next partial state to be merged with state.
         * @param {?function} callback Called after state is updated.
         * @final
         * @protected
         */
        setState: function(partialState, callback) {
          ("production" !== "development" ? invariant(
            typeof partialState === 'object' || partialState == null,
            'setState(...): takes an object of state variables to update.'
          ) : invariant(typeof partialState === 'object' || partialState == null));
          if ("production" !== "development"){
            ("production" !== "development" ? warning(
              partialState != null,
              'setState(...): You passed an undefined or null state object; ' +
              'instead, use forceUpdate().'
            ) : null);
          }
          // Merge with `_pendingState` if it exists, otherwise with existing state.
          this.replaceState(
            merge(this._pendingState || this.state, partialState),
            callback
          );
        },
      
        /**
         * Replaces all of the state. Always use this or `setState` to mutate state.
         * You should treat `this.state` as immutable.
         *
         * There is no guarantee that `this.state` will be immediately updated, so
         * accessing `this.state` after calling this method may return the old value.
         *
         * @param {object} completeState Next state.
         * @param {?function} callback Called after state is updated.
         * @final
         * @protected
         */
        replaceState: function(completeState, callback) {
          validateLifeCycleOnReplaceState(this);
          this._pendingState = completeState;
          if (this._compositeLifeCycleState !== CompositeLifeCycle.MOUNTING) {
            // If we're in a componentWillMount handler, don't enqueue a rerender
            // because ReactUpdates assumes we're in a browser context (which is wrong
            // for server rendering) and we're about to do a render anyway.
            // TODO: The callback here is ignored when setState is called from
            // componentWillMount. Either fix it or disallow doing so completely in
            // favor of getInitialState.
            ReactUpdates.enqueueUpdate(this, callback);
          }
        },
      
        /**
         * Filters the context object to only contain keys specified in
         * `contextTypes`, and asserts that they are valid.
         *
         * @param {object} context
         * @return {?object}
         * @private
         */
        _processContext: function(context) {
          var maskedContext = null;
          var contextTypes = this.constructor.contextTypes;
          if (contextTypes) {
            maskedContext = {};
            for (var contextName in contextTypes) {
              maskedContext[contextName] = context[contextName];
            }
            if ("production" !== "development") {
              this._checkPropTypes(
                contextTypes,
                maskedContext,
                ReactPropTypeLocations.context
              );
            }
          }
          return maskedContext;
        },
      
        /**
         * @param {object} currentContext
         * @return {object}
         * @private
         */
        _processChildContext: function(currentContext) {
          var childContext = this.getChildContext && this.getChildContext();
          var displayName = this.constructor.displayName || 'ReactCompositeComponent';
          if (childContext) {
            ("production" !== "development" ? invariant(
              typeof this.constructor.childContextTypes === 'object',
              '%s.getChildContext(): childContextTypes must be defined in order to ' +
              'use getChildContext().',
              displayName
            ) : invariant(typeof this.constructor.childContextTypes === 'object'));
            if ("production" !== "development") {
              this._checkPropTypes(
                this.constructor.childContextTypes,
                childContext,
                ReactPropTypeLocations.childContext
              );
            }
            for (var name in childContext) {
              ("production" !== "development" ? invariant(
                name in this.constructor.childContextTypes,
                '%s.getChildContext(): key "%s" is not defined in childContextTypes.',
                displayName,
                name
              ) : invariant(name in this.constructor.childContextTypes));
            }
            return merge(currentContext, childContext);
          }
          return currentContext;
        },
      
        /**
         * Processes props by setting default values for unspecified props and
         * asserting that the props are valid. Does not mutate its argument; returns
         * a new props object with defaults merged in.
         *
         * @param {object} newProps
         * @return {object}
         * @private
         */
        _processProps: function(newProps) {
          var defaultProps = this.constructor.defaultProps;
          var props;
          if (defaultProps) {
            props = merge(newProps);
            for (var propName in defaultProps) {
              if (typeof props[propName] === 'undefined') {
                props[propName] = defaultProps[propName];
              }
            }
          } else {
            props = newProps;
          }
          if ("production" !== "development") {
            var propTypes = this.constructor.propTypes;
            if (propTypes) {
              this._checkPropTypes(propTypes, props, ReactPropTypeLocations.prop);
            }
          }
          return props;
        },
      
        /**
         * Assert that the props are valid
         *
         * @param {object} propTypes Map of prop name to a ReactPropType
         * @param {object} props
         * @param {string} location e.g. "prop", "context", "child context"
         * @private
         */
        _checkPropTypes: function(propTypes, props, location) {
          // TODO: Stop validating prop types here and only use the descriptor
          // validation.
          var componentName = this.constructor.displayName;
          for (var propName in propTypes) {
            if (propTypes.hasOwnProperty(propName)) {
              var error =
                propTypes[propName](props, propName, componentName, location);
              if (error instanceof Error) {
                // We may want to extend this logic for similar errors in
                // renderComponent calls, so I'm abstracting it away into
                // a function to minimize refactoring in the future
                var addendum = getDeclarationErrorAddendum(this);
                ("production" !== "development" ? warning(false, error.message + addendum) : null);
              }
            }
          }
        },
      
        /**
         * If any of `_pendingDescriptor`, `_pendingState`, or `_pendingForceUpdate`
         * is set, update the component.
         *
         * @param {ReactReconcileTransaction} transaction
         * @internal
         */
        performUpdateIfNecessary: function(transaction) {
          var compositeLifeCycleState = this._compositeLifeCycleState;
          // Do not trigger a state transition if we are in the middle of mounting or
          // receiving props because both of those will already be doing this.
          if (compositeLifeCycleState === CompositeLifeCycle.MOUNTING ||
              compositeLifeCycleState === CompositeLifeCycle.RECEIVING_PROPS) {
            return;
          }
      
          if (this._pendingDescriptor == null &&
              this._pendingState == null &&
              !this._pendingForceUpdate) {
            return;
          }
      
          var nextContext = this.context;
          var nextProps = this.props;
          var nextDescriptor = this._descriptor;
          if (this._pendingDescriptor != null) {
            nextDescriptor = this._pendingDescriptor;
            nextContext = this._processContext(nextDescriptor._context);
            nextProps = this._processProps(nextDescriptor.props);
            this._pendingDescriptor = null;
      
            this._compositeLifeCycleState = CompositeLifeCycle.RECEIVING_PROPS;
            if (this.componentWillReceiveProps) {
              this.componentWillReceiveProps(nextProps, nextContext);
            }
          }
      
          this._compositeLifeCycleState = CompositeLifeCycle.RECEIVING_STATE;
      
          var nextState = this._pendingState || this.state;
          this._pendingState = null;
      
          try {
            var shouldUpdate =
              this._pendingForceUpdate ||
              !this.shouldComponentUpdate ||
              this.shouldComponentUpdate(nextProps, nextState, nextContext);
      
            if ("production" !== "development") {
              if (typeof shouldUpdate === "undefined") {
                console.warn(
                  (this.constructor.displayName || 'ReactCompositeComponent') +
                  '.shouldComponentUpdate(): Returned undefined instead of a ' +
                  'boolean value. Make sure to return true or false.'
                );
              }
            }
      
            if (shouldUpdate) {
              this._pendingForceUpdate = false;
              // Will set `this.props`, `this.state` and `this.context`.
              this._performComponentUpdate(
                nextDescriptor,
                nextProps,
                nextState,
                nextContext,
                transaction
              );
            } else {
              // If it's determined that a component should not update, we still want
              // to set props and state.
              this._descriptor = nextDescriptor;
              this.props = nextProps;
              this.state = nextState;
              this.context = nextContext;
      
              // Owner cannot change because shouldUpdateReactComponent doesn't allow
              // it. TODO: Remove this._owner completely.
              this._owner = nextDescriptor._owner;
            }
          } finally {
            this._compositeLifeCycleState = null;
          }
        },
      
        /**
         * Merges new props and state, notifies delegate methods of update and
         * performs update.
         *
         * @param {ReactDescriptor} nextDescriptor Next descriptor
         * @param {object} nextProps Next public object to set as properties.
         * @param {?object} nextState Next object to set as state.
         * @param {?object} nextContext Next public object to set as context.
         * @param {ReactReconcileTransaction} transaction
         * @private
         */
        _performComponentUpdate: function(
          nextDescriptor,
          nextProps,
          nextState,
          nextContext,
          transaction
        ) {
          var prevDescriptor = this._descriptor;
          var prevProps = this.props;
          var prevState = this.state;
          var prevContext = this.context;
      
          if (this.componentWillUpdate) {
            this.componentWillUpdate(nextProps, nextState, nextContext);
          }
      
          this._descriptor = nextDescriptor;
          this.props = nextProps;
          this.state = nextState;
          this.context = nextContext;
      
          // Owner cannot change because shouldUpdateReactComponent doesn't allow
          // it. TODO: Remove this._owner completely.
          this._owner = nextDescriptor._owner;
      
          this.updateComponent(
            transaction,
            prevDescriptor
          );
      
          if (this.componentDidUpdate) {
            transaction.getReactMountReady().enqueue(
              this.componentDidUpdate.bind(this, prevProps, prevState, prevContext),
              this
            );
          }
        },
      
        receiveComponent: function(nextDescriptor, transaction) {
          if (nextDescriptor === this._descriptor &&
              nextDescriptor._owner != null) {
            // Since descriptors are immutable after the owner is rendered,
            // we can do a cheap identity compare here to determine if this is a
            // superfluous reconcile. It's possible for state to be mutable but such
            // change should trigger an update of the owner which would recreate
            // the descriptor. We explicitly check for the existence of an owner since
            // it's possible for a descriptor created outside a composite to be
            // deeply mutated and reused.
            return;
          }
      
          ReactComponent.Mixin.receiveComponent.call(
            this,
            nextDescriptor,
            transaction
          );
        },
      
        /**
         * Updates the component's currently mounted DOM representation.
         *
         * By default, this implements React's rendering and reconciliation algorithm.
         * Sophisticated clients may wish to override this.
         *
         * @param {ReactReconcileTransaction} transaction
         * @param {ReactDescriptor} prevDescriptor
         * @internal
         * @overridable
         */
        updateComponent: ReactPerf.measure(
          'ReactCompositeComponent',
          'updateComponent',
          function(transaction, prevParentDescriptor) {
            ReactComponent.Mixin.updateComponent.call(
              this,
              transaction,
              prevParentDescriptor
            );
      
            var prevComponentInstance = this._renderedComponent;
            var prevDescriptor = prevComponentInstance._descriptor;
            var nextDescriptor = this._renderValidatedComponent();
            if (shouldUpdateReactComponent(prevDescriptor, nextDescriptor)) {
              prevComponentInstance.receiveComponent(nextDescriptor, transaction);
            } else {
              // These two IDs are actually the same! But nothing should rely on that.
              var thisID = this._rootNodeID;
              var prevComponentID = prevComponentInstance._rootNodeID;
              prevComponentInstance.unmountComponent();
              this._renderedComponent = instantiateReactComponent(nextDescriptor);
              var nextMarkup = this._renderedComponent.mountComponent(
                thisID,
                transaction,
                this._mountDepth + 1
              );
              ReactComponent.BackendIDOperations.dangerouslyReplaceNodeWithMarkupByID(
                prevComponentID,
                nextMarkup
              );
            }
          }
        ),
      
        /**
         * Forces an update. This should only be invoked when it is known with
         * certainty that we are **not** in a DOM transaction.
         *
         * You may want to call this when you know that some deeper aspect of the
         * component's state has changed but `setState` was not called.
         *
         * This will not invoke `shouldUpdateComponent`, but it will invoke
         * `componentWillUpdate` and `componentDidUpdate`.
         *
         * @param {?function} callback Called after update is complete.
         * @final
         * @protected
         */
        forceUpdate: function(callback) {
          var compositeLifeCycleState = this._compositeLifeCycleState;
          ("production" !== "development" ? invariant(
            this.isMounted() ||
              compositeLifeCycleState === CompositeLifeCycle.MOUNTING,
            'forceUpdate(...): Can only force an update on mounted or mounting ' +
              'components.'
          ) : invariant(this.isMounted() ||
            compositeLifeCycleState === CompositeLifeCycle.MOUNTING));
          ("production" !== "development" ? invariant(
            compositeLifeCycleState !== CompositeLifeCycle.RECEIVING_STATE &&
            compositeLifeCycleState !== CompositeLifeCycle.UNMOUNTING,
            'forceUpdate(...): Cannot force an update while unmounting component ' +
            'or during an existing state transition (such as within `render`).'
          ) : invariant(compositeLifeCycleState !== CompositeLifeCycle.RECEIVING_STATE &&
          compositeLifeCycleState !== CompositeLifeCycle.UNMOUNTING));
          this._pendingForceUpdate = true;
          ReactUpdates.enqueueUpdate(this, callback);
        },
      
        /**
         * @private
         */
        _renderValidatedComponent: ReactPerf.measure(
          'ReactCompositeComponent',
          '_renderValidatedComponent',
          function() {
            var renderedComponent;
            var previousContext = ReactContext.current;
            ReactContext.current = this._processChildContext(
              this._descriptor._context
            );
            ReactCurrentOwner.current = this;
            try {
              renderedComponent = this.render();
              if (renderedComponent === null || renderedComponent === false) {
                renderedComponent = ReactEmptyComponent.getEmptyComponent();
                ReactEmptyComponent.registerNullComponentID(this._rootNodeID);
              } else {
                ReactEmptyComponent.deregisterNullComponentID(this._rootNodeID);
              }
            } finally {
              ReactContext.current = previousContext;
              ReactCurrentOwner.current = null;
            }
            ("production" !== "development" ? invariant(
              ReactDescriptor.isValidDescriptor(renderedComponent),
              '%s.render(): A valid ReactComponent must be returned. You may have ' +
                'returned undefined, an array or some other invalid object.',
              this.constructor.displayName || 'ReactCompositeComponent'
            ) : invariant(ReactDescriptor.isValidDescriptor(renderedComponent)));
            return renderedComponent;
          }
        ),
      
        /**
         * @private
         */
        _bindAutoBindMethods: function() {
          for (var autoBindKey in this.__reactAutoBindMap) {
            if (!this.__reactAutoBindMap.hasOwnProperty(autoBindKey)) {
              continue;
            }
            var method = this.__reactAutoBindMap[autoBindKey];
            this[autoBindKey] = this._bindAutoBindMethod(ReactErrorUtils.guard(
              method,
              this.constructor.displayName + '.' + autoBindKey
            ));
          }
        },
      
        /**
         * Binds a method to the component.
         *
         * @param {function} method Method to be bound.
         * @private
         */
        _bindAutoBindMethod: function(method) {
          var component = this;
          var boundMethod = function() {
            return method.apply(component, arguments);
          };
          if ("production" !== "development") {
            boundMethod.__reactBoundContext = component;
            boundMethod.__reactBoundMethod = method;
            boundMethod.__reactBoundArguments = null;
            var componentName = component.constructor.displayName;
            var _bind = boundMethod.bind;
            boundMethod.bind = function(newThis ) {var args=Array.prototype.slice.call(arguments,1);
              // User is trying to bind() an autobound method; we effectively will
              // ignore the value of "this" that the user is trying to use, so
              // let's warn.
              if (newThis !== component && newThis !== null) {
                monitorCodeUse('react_bind_warning', { component: componentName });
                console.warn(
                  'bind(): React component methods may only be bound to the ' +
                  'component instance. See ' + componentName
                );
              } else if (!args.length) {
                monitorCodeUse('react_bind_warning', { component: componentName });
                console.warn(
                  'bind(): You are binding a component method to the component. ' +
                  'React does this for you automatically in a high-performance ' +
                  'way, so you can safely remove this call. See ' + componentName
                );
                return boundMethod;
              }
              var reboundMethod = _bind.apply(boundMethod, arguments);
              reboundMethod.__reactBoundContext = component;
              reboundMethod.__reactBoundMethod = method;
              reboundMethod.__reactBoundArguments = args;
              return reboundMethod;
            };
          }
          return boundMethod;
        }
      };
      
      var ReactCompositeComponentBase = function() {};
      mixInto(ReactCompositeComponentBase, ReactComponent.Mixin);
      mixInto(ReactCompositeComponentBase, ReactOwner.Mixin);
      mixInto(ReactCompositeComponentBase, ReactPropTransferer.Mixin);
      mixInto(ReactCompositeComponentBase, ReactCompositeComponentMixin);
      
      /**
       * Module for creating composite components.
       *
       * @class ReactCompositeComponent
       * @extends ReactComponent
       * @extends ReactOwner
       * @extends ReactPropTransferer
       */
      var ReactCompositeComponent = {
      
        LifeCycle: CompositeLifeCycle,
      
        Base: ReactCompositeComponentBase,
      
        /**
         * Creates a composite component class given a class specification.
         *
         * @param {object} spec Class specification (which must define `render`).
         * @return {function} Component constructor function.
         * @public
         */
        createClass: function(spec) {
          var Constructor = function(props, owner) {
            this.construct(props, owner);
          };
          Constructor.prototype = new ReactCompositeComponentBase();
          Constructor.prototype.constructor = Constructor;
      
          injectedMixins.forEach(
            mixSpecIntoComponent.bind(null, Constructor)
          );
      
          mixSpecIntoComponent(Constructor, spec);
      
          // Initialize the defaultProps property after all mixins have been merged
          if (Constructor.getDefaultProps) {
            Constructor.defaultProps = Constructor.getDefaultProps();
          }
      
          ("production" !== "development" ? invariant(
            Constructor.prototype.render,
            'createClass(...): Class specification must implement a `render` method.'
          ) : invariant(Constructor.prototype.render));
      
          if ("production" !== "development") {
            if (Constructor.prototype.componentShouldUpdate) {
              monitorCodeUse(
                'react_component_should_update_warning',
                { component: spec.displayName }
              );
              console.warn(
                (spec.displayName || 'A component') + ' has a method called ' +
                'componentShouldUpdate(). Did you mean shouldComponentUpdate()? ' +
                'The name is phrased as a question because the function is ' +
                'expected to return a value.'
               );
            }
          }
      
          // Reduce time spent doing lookups by setting these on the prototype.
          for (var methodName in ReactCompositeComponentInterface) {
            if (!Constructor.prototype[methodName]) {
              Constructor.prototype[methodName] = null;
            }
          }
      
          var descriptorFactory = ReactDescriptor.createFactory(Constructor);
      
          if ("production" !== "development") {
            return ReactDescriptorValidator.createFactory(
              descriptorFactory,
              Constructor.propTypes,
              Constructor.contextTypes
            );
          }
      
          return descriptorFactory;
        },
      
        injection: {
          injectMixin: function(mixin) {
            injectedMixins.push(mixin);
          }
        }
      };
      
      module.exports = ReactCompositeComponent;
      
      },{"./ReactComponent":31,"./ReactContext":34,"./ReactCurrentOwner":35,"./ReactDescriptor":51,"./ReactDescriptorValidator":52,"./ReactEmptyComponent":53,"./ReactErrorUtils":54,"./ReactOwner":64,"./ReactPerf":65,"./ReactPropTransferer":66,"./ReactPropTypeLocationNames":67,"./ReactPropTypeLocations":68,"./ReactUpdates":76,"./instantiateReactComponent":119,"./invariant":120,"./keyMirror":126,"./mapObject":128,"./merge":130,"./mixInto":133,"./monitorCodeUse":134,"./shouldUpdateReactComponent":140,"./warning":143}],34:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactContext
       */
      
      "use strict";
      
      var merge = _dereq_("./merge");
      
      /**
       * Keeps track of the current context.
       *
       * The context is automatically passed down the component ownership hierarchy
       * and is accessible via `this.context` on ReactCompositeComponents.
       */
      var ReactContext = {
      
        /**
         * @internal
         * @type {object}
         */
        current: {},
      
        /**
         * Temporarily extends the current context while executing scopedCallback.
         *
         * A typical use case might look like
         *
         *  render: function() {
         *    var children = ReactContext.withContext({foo: 'foo'} () => (
         *
         *    ));
         *    return <div>{children}</div>;
         *  }
         *
         * @param {object} newContext New context to merge into the existing context
         * @param {function} scopedCallback Callback to run with the new context
         * @return {ReactComponent|array<ReactComponent>}
         */
        withContext: function(newContext, scopedCallback) {
          var result;
          var previousContext = ReactContext.current;
          ReactContext.current = merge(previousContext, newContext);
          try {
            result = scopedCallback();
          } finally {
            ReactContext.current = previousContext;
          }
          return result;
        }
      
      };
      
      module.exports = ReactContext;
      
      },{"./merge":130}],35:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactCurrentOwner
       */
      
      "use strict";
      
      /**
       * Keeps track of the current owner.
       *
       * The current owner is the component who should own any components that are
       * currently being constructed.
       *
       * The depth indicate how many composite components are above this render level.
       */
      var ReactCurrentOwner = {
      
        /**
         * @internal
         * @type {ReactComponent}
         */
        current: null
      
      };
      
      module.exports = ReactCurrentOwner;
      
      },{}],36:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDOM
       * @typechecks static-only
       */
      
      "use strict";
      
      var ReactDescriptor = _dereq_("./ReactDescriptor");
      var ReactDescriptorValidator = _dereq_("./ReactDescriptorValidator");
      var ReactDOMComponent = _dereq_("./ReactDOMComponent");
      
      var mergeInto = _dereq_("./mergeInto");
      var mapObject = _dereq_("./mapObject");
      
      /**
       * Creates a new React class that is idempotent and capable of containing other
       * React components. It accepts event listeners and DOM properties that are
       * valid according to `DOMProperty`.
       *
       *  - Event listeners: `onClick`, `onMouseDown`, etc.
       *  - DOM properties: `className`, `name`, `title`, etc.
       *
       * The `style` property functions differently from the DOM API. It accepts an
       * object mapping of style properties to values.
       *
       * @param {boolean} omitClose True if the close tag should be omitted.
       * @param {string} tag Tag name (e.g. `div`).
       * @private
       */
      function createDOMComponentClass(omitClose, tag) {
        var Constructor = function(descriptor) {
          this.construct(descriptor);
        };
        Constructor.prototype = new ReactDOMComponent(tag, omitClose);
        Constructor.prototype.constructor = Constructor;
        Constructor.displayName = tag;
      
        var ConvenienceConstructor = ReactDescriptor.createFactory(Constructor);
      
        if ("production" !== "development") {
          return ReactDescriptorValidator.createFactory(
            ConvenienceConstructor
          );
        }
      
        return ConvenienceConstructor;
      }
      
      /**
       * Creates a mapping from supported HTML tags to `ReactDOMComponent` classes.
       * This is also accessible via `React.DOM`.
       *
       * @public
       */
      var ReactDOM = mapObject({
        a: false,
        abbr: false,
        address: false,
        area: true,
        article: false,
        aside: false,
        audio: false,
        b: false,
        base: true,
        bdi: false,
        bdo: false,
        big: false,
        blockquote: false,
        body: false,
        br: true,
        button: false,
        canvas: false,
        caption: false,
        cite: false,
        code: false,
        col: true,
        colgroup: false,
        data: false,
        datalist: false,
        dd: false,
        del: false,
        details: false,
        dfn: false,
        dialog: false,
        div: false,
        dl: false,
        dt: false,
        em: false,
        embed: true,
        fieldset: false,
        figcaption: false,
        figure: false,
        footer: false,
        form: false, // NOTE: Injected, see `ReactDOMForm`.
        h1: false,
        h2: false,
        h3: false,
        h4: false,
        h5: false,
        h6: false,
        head: false,
        header: false,
        hr: true,
        html: false,
        i: false,
        iframe: false,
        img: true,
        input: true,
        ins: false,
        kbd: false,
        keygen: true,
        label: false,
        legend: false,
        li: false,
        link: true,
        main: false,
        map: false,
        mark: false,
        menu: false,
        menuitem: false, // NOTE: Close tag should be omitted, but causes problems.
        meta: true,
        meter: false,
        nav: false,
        noscript: false,
        object: false,
        ol: false,
        optgroup: false,
        option: false,
        output: false,
        p: false,
        param: true,
        picture: false,
        pre: false,
        progress: false,
        q: false,
        rp: false,
        rt: false,
        ruby: false,
        s: false,
        samp: false,
        script: false,
        section: false,
        select: false,
        small: false,
        source: true,
        span: false,
        strong: false,
        style: false,
        sub: false,
        summary: false,
        sup: false,
        table: false,
        tbody: false,
        td: false,
        textarea: false, // NOTE: Injected, see `ReactDOMTextarea`.
        tfoot: false,
        th: false,
        thead: false,
        time: false,
        title: false,
        tr: false,
        track: true,
        u: false,
        ul: false,
        'var': false,
        video: false,
        wbr: true,
      
        // SVG
        circle: false,
        defs: false,
        ellipse: false,
        g: false,
        line: false,
        linearGradient: false,
        mask: false,
        path: false,
        pattern: false,
        polygon: false,
        polyline: false,
        radialGradient: false,
        rect: false,
        stop: false,
        svg: false,
        text: false,
        tspan: false
      }, createDOMComponentClass);
      
      var injection = {
        injectComponentClasses: function(componentClasses) {
          mergeInto(ReactDOM, componentClasses);
        }
      };
      
      ReactDOM.injection = injection;
      
      module.exports = ReactDOM;
      
      },{"./ReactDOMComponent":38,"./ReactDescriptor":51,"./ReactDescriptorValidator":52,"./mapObject":128,"./mergeInto":132}],37:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDOMButton
       */
      
      "use strict";
      
      var AutoFocusMixin = _dereq_("./AutoFocusMixin");
      var ReactBrowserComponentMixin = _dereq_("./ReactBrowserComponentMixin");
      var ReactCompositeComponent = _dereq_("./ReactCompositeComponent");
      var ReactDOM = _dereq_("./ReactDOM");
      
      var keyMirror = _dereq_("./keyMirror");
      
      // Store a reference to the <button> `ReactDOMComponent`.
      var button = ReactDOM.button;
      
      var mouseListenerNames = keyMirror({
        onClick: true,
        onDoubleClick: true,
        onMouseDown: true,
        onMouseMove: true,
        onMouseUp: true,
        onClickCapture: true,
        onDoubleClickCapture: true,
        onMouseDownCapture: true,
        onMouseMoveCapture: true,
        onMouseUpCapture: true
      });
      
      /**
       * Implements a <button> native component that does not receive mouse events
       * when `disabled` is set.
       */
      var ReactDOMButton = ReactCompositeComponent.createClass({
        displayName: 'ReactDOMButton',
      
        mixins: [AutoFocusMixin, ReactBrowserComponentMixin],
      
        render: function() {
          var props = {};
      
          // Copy the props; except the mouse listeners if we're disabled
          for (var key in this.props) {
            if (this.props.hasOwnProperty(key) &&
                (!this.props.disabled || !mouseListenerNames[key])) {
              props[key] = this.props[key];
            }
          }
      
          return button(props, this.props.children);
        }
      
      });
      
      module.exports = ReactDOMButton;
      
      },{"./AutoFocusMixin":1,"./ReactBrowserComponentMixin":28,"./ReactCompositeComponent":33,"./ReactDOM":36,"./keyMirror":126}],38:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDOMComponent
       * @typechecks static-only
       */
      
      "use strict";
      
      var CSSPropertyOperations = _dereq_("./CSSPropertyOperations");
      var DOMProperty = _dereq_("./DOMProperty");
      var DOMPropertyOperations = _dereq_("./DOMPropertyOperations");
      var ReactBrowserComponentMixin = _dereq_("./ReactBrowserComponentMixin");
      var ReactComponent = _dereq_("./ReactComponent");
      var ReactBrowserEventEmitter = _dereq_("./ReactBrowserEventEmitter");
      var ReactMount = _dereq_("./ReactMount");
      var ReactMultiChild = _dereq_("./ReactMultiChild");
      var ReactPerf = _dereq_("./ReactPerf");
      
      var escapeTextForBrowser = _dereq_("./escapeTextForBrowser");
      var invariant = _dereq_("./invariant");
      var keyOf = _dereq_("./keyOf");
      var merge = _dereq_("./merge");
      var mixInto = _dereq_("./mixInto");
      
      var deleteListener = ReactBrowserEventEmitter.deleteListener;
      var listenTo = ReactBrowserEventEmitter.listenTo;
      var registrationNameModules = ReactBrowserEventEmitter.registrationNameModules;
      
      // For quickly matching children type, to test if can be treated as content.
      var CONTENT_TYPES = {'string': true, 'number': true};
      
      var STYLE = keyOf({style: null});
      
      var ELEMENT_NODE_TYPE = 1;
      
      /**
       * @param {?object} props
       */
      function assertValidProps(props) {
        if (!props) {
          return;
        }
        // Note the use of `==` which checks for null or undefined.
        ("production" !== "development" ? invariant(
          props.children == null || props.dangerouslySetInnerHTML == null,
          'Can only set one of `children` or `props.dangerouslySetInnerHTML`.'
        ) : invariant(props.children == null || props.dangerouslySetInnerHTML == null));
        ("production" !== "development" ? invariant(
          props.style == null || typeof props.style === 'object',
          'The `style` prop expects a mapping from style properties to values, ' +
          'not a string.'
        ) : invariant(props.style == null || typeof props.style === 'object'));
      }
      
      function putListener(id, registrationName, listener, transaction) {
        var container = ReactMount.findReactContainerForID(id);
        if (container) {
          var doc = container.nodeType === ELEMENT_NODE_TYPE ?
            container.ownerDocument :
            container;
          listenTo(registrationName, doc);
        }
        transaction.getPutListenerQueue().enqueuePutListener(
          id,
          registrationName,
          listener
        );
      }
      
      
      /**
       * @constructor ReactDOMComponent
       * @extends ReactComponent
       * @extends ReactMultiChild
       */
      function ReactDOMComponent(tag, omitClose) {
        this._tagOpen = '<' + tag;
        this._tagClose = omitClose ? '' : '</' + tag + '>';
        this.tagName = tag.toUpperCase();
      }
      
      ReactDOMComponent.Mixin = {
      
        /**
         * Generates root tag markup then recurses. This method has side effects and
         * is not idempotent.
         *
         * @internal
         * @param {string} rootID The root DOM ID for this node.
         * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
         * @param {number} mountDepth number of components in the owner hierarchy
         * @return {string} The computed markup.
         */
        mountComponent: ReactPerf.measure(
          'ReactDOMComponent',
          'mountComponent',
          function(rootID, transaction, mountDepth) {
            ReactComponent.Mixin.mountComponent.call(
              this,
              rootID,
              transaction,
              mountDepth
            );
            assertValidProps(this.props);
            return (
              this._createOpenTagMarkupAndPutListeners(transaction) +
              this._createContentMarkup(transaction) +
              this._tagClose
            );
          }
        ),
      
        /**
         * Creates markup for the open tag and all attributes.
         *
         * This method has side effects because events get registered.
         *
         * Iterating over object properties is faster than iterating over arrays.
         * @see http://jsperf.com/obj-vs-arr-iteration
         *
         * @private
         * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
         * @return {string} Markup of opening tag.
         */
        _createOpenTagMarkupAndPutListeners: function(transaction) {
          var props = this.props;
          var ret = this._tagOpen;
      
          for (var propKey in props) {
            if (!props.hasOwnProperty(propKey)) {
              continue;
            }
            var propValue = props[propKey];
            if (propValue == null) {
              continue;
            }
            if (registrationNameModules.hasOwnProperty(propKey)) {
              putListener(this._rootNodeID, propKey, propValue, transaction);
            } else {
              if (propKey === STYLE) {
                if (propValue) {
                  propValue = props.style = merge(props.style);
                }
                propValue = CSSPropertyOperations.createMarkupForStyles(propValue);
              }
              var markup =
                DOMPropertyOperations.createMarkupForProperty(propKey, propValue);
              if (markup) {
                ret += ' ' + markup;
              }
            }
          }
      
          // For static pages, no need to put React ID and checksum. Saves lots of
          // bytes.
          if (transaction.renderToStaticMarkup) {
            return ret + '>';
          }
      
          var markupForID = DOMPropertyOperations.createMarkupForID(this._rootNodeID);
          return ret + ' ' + markupForID + '>';
        },
      
        /**
         * Creates markup for the content between the tags.
         *
         * @private
         * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
         * @return {string} Content markup.
         */
        _createContentMarkup: function(transaction) {
          // Intentional use of != to avoid catching zero/false.
          var innerHTML = this.props.dangerouslySetInnerHTML;
          if (innerHTML != null) {
            if (innerHTML.__html != null) {
              return innerHTML.__html;
            }
          } else {
            var contentToUse =
              CONTENT_TYPES[typeof this.props.children] ? this.props.children : null;
            var childrenToUse = contentToUse != null ? null : this.props.children;
            if (contentToUse != null) {
              return escapeTextForBrowser(contentToUse);
            } else if (childrenToUse != null) {
              var mountImages = this.mountChildren(
                childrenToUse,
                transaction
              );
              return mountImages.join('');
            }
          }
          return '';
        },
      
        receiveComponent: function(nextDescriptor, transaction) {
          if (nextDescriptor === this._descriptor &&
              nextDescriptor._owner != null) {
            // Since descriptors are immutable after the owner is rendered,
            // we can do a cheap identity compare here to determine if this is a
            // superfluous reconcile. It's possible for state to be mutable but such
            // change should trigger an update of the owner which would recreate
            // the descriptor. We explicitly check for the existence of an owner since
            // it's possible for a descriptor created outside a composite to be
            // deeply mutated and reused.
            return;
          }
      
          ReactComponent.Mixin.receiveComponent.call(
            this,
            nextDescriptor,
            transaction
          );
        },
      
        /**
         * Updates a native DOM component after it has already been allocated and
         * attached to the DOM. Reconciles the root DOM node, then recurses.
         *
         * @param {ReactReconcileTransaction} transaction
         * @param {ReactDescriptor} prevDescriptor
         * @internal
         * @overridable
         */
        updateComponent: ReactPerf.measure(
          'ReactDOMComponent',
          'updateComponent',
          function(transaction, prevDescriptor) {
            assertValidProps(this._descriptor.props);
            ReactComponent.Mixin.updateComponent.call(
              this,
              transaction,
              prevDescriptor
            );
            this._updateDOMProperties(prevDescriptor.props, transaction);
            this._updateDOMChildren(prevDescriptor.props, transaction);
          }
        ),
      
        /**
         * Reconciles the properties by detecting differences in property values and
         * updating the DOM as necessary. This function is probably the single most
         * critical path for performance optimization.
         *
         * TODO: Benchmark whether checking for changed values in memory actually
         *       improves performance (especially statically positioned elements).
         * TODO: Benchmark the effects of putting this at the top since 99% of props
         *       do not change for a given reconciliation.
         * TODO: Benchmark areas that can be improved with caching.
         *
         * @private
         * @param {object} lastProps
         * @param {ReactReconcileTransaction} transaction
         */
        _updateDOMProperties: function(lastProps, transaction) {
          var nextProps = this.props;
          var propKey;
          var styleName;
          var styleUpdates;
          for (propKey in lastProps) {
            if (nextProps.hasOwnProperty(propKey) ||
               !lastProps.hasOwnProperty(propKey)) {
              continue;
            }
            if (propKey === STYLE) {
              var lastStyle = lastProps[propKey];
              for (styleName in lastStyle) {
                if (lastStyle.hasOwnProperty(styleName)) {
                  styleUpdates = styleUpdates || {};
                  styleUpdates[styleName] = '';
                }
              }
            } else if (registrationNameModules.hasOwnProperty(propKey)) {
              deleteListener(this._rootNodeID, propKey);
            } else if (
                DOMProperty.isStandardName[propKey] ||
                DOMProperty.isCustomAttribute(propKey)) {
              ReactComponent.BackendIDOperations.deletePropertyByID(
                this._rootNodeID,
                propKey
              );
            }
          }
          for (propKey in nextProps) {
            var nextProp = nextProps[propKey];
            var lastProp = lastProps[propKey];
            if (!nextProps.hasOwnProperty(propKey) || nextProp === lastProp) {
              continue;
            }
            if (propKey === STYLE) {
              if (nextProp) {
                nextProp = nextProps.style = merge(nextProp);
              }
              if (lastProp) {
                // Unset styles on `lastProp` but not on `nextProp`.
                for (styleName in lastProp) {
                  if (lastProp.hasOwnProperty(styleName) &&
                      (!nextProp || !nextProp.hasOwnProperty(styleName))) {
                    styleUpdates = styleUpdates || {};
                    styleUpdates[styleName] = '';
                  }
                }
                // Update styles that changed since `lastProp`.
                for (styleName in nextProp) {
                  if (nextProp.hasOwnProperty(styleName) &&
                      lastProp[styleName] !== nextProp[styleName]) {
                    styleUpdates = styleUpdates || {};
                    styleUpdates[styleName] = nextProp[styleName];
                  }
                }
              } else {
                // Relies on `updateStylesByID` not mutating `styleUpdates`.
                styleUpdates = nextProp;
              }
            } else if (registrationNameModules.hasOwnProperty(propKey)) {
              putListener(this._rootNodeID, propKey, nextProp, transaction);
            } else if (
                DOMProperty.isStandardName[propKey] ||
                DOMProperty.isCustomAttribute(propKey)) {
              ReactComponent.BackendIDOperations.updatePropertyByID(
                this._rootNodeID,
                propKey,
                nextProp
              );
            }
          }
          if (styleUpdates) {
            ReactComponent.BackendIDOperations.updateStylesByID(
              this._rootNodeID,
              styleUpdates
            );
          }
        },
      
        /**
         * Reconciles the children with the various properties that affect the
         * children content.
         *
         * @param {object} lastProps
         * @param {ReactReconcileTransaction} transaction
         */
        _updateDOMChildren: function(lastProps, transaction) {
          var nextProps = this.props;
      
          var lastContent =
            CONTENT_TYPES[typeof lastProps.children] ? lastProps.children : null;
          var nextContent =
            CONTENT_TYPES[typeof nextProps.children] ? nextProps.children : null;
      
          var lastHtml =
            lastProps.dangerouslySetInnerHTML &&
            lastProps.dangerouslySetInnerHTML.__html;
          var nextHtml =
            nextProps.dangerouslySetInnerHTML &&
            nextProps.dangerouslySetInnerHTML.__html;
      
          // Note the use of `!=` which checks for null or undefined.
          var lastChildren = lastContent != null ? null : lastProps.children;
          var nextChildren = nextContent != null ? null : nextProps.children;
      
          // If we're switching from children to content/html or vice versa, remove
          // the old content
          var lastHasContentOrHtml = lastContent != null || lastHtml != null;
          var nextHasContentOrHtml = nextContent != null || nextHtml != null;
          if (lastChildren != null && nextChildren == null) {
            this.updateChildren(null, transaction);
          } else if (lastHasContentOrHtml && !nextHasContentOrHtml) {
            this.updateTextContent('');
          }
      
          if (nextContent != null) {
            if (lastContent !== nextContent) {
              this.updateTextContent('' + nextContent);
            }
          } else if (nextHtml != null) {
            if (lastHtml !== nextHtml) {
              ReactComponent.BackendIDOperations.updateInnerHTMLByID(
                this._rootNodeID,
                nextHtml
              );
            }
          } else if (nextChildren != null) {
            this.updateChildren(nextChildren, transaction);
          }
        },
      
        /**
         * Destroys all event registrations for this instance. Does not remove from
         * the DOM. That must be done by the parent.
         *
         * @internal
         */
        unmountComponent: function() {
          this.unmountChildren();
          ReactBrowserEventEmitter.deleteAllListeners(this._rootNodeID);
          ReactComponent.Mixin.unmountComponent.call(this);
        }
      
      };
      
      mixInto(ReactDOMComponent, ReactComponent.Mixin);
      mixInto(ReactDOMComponent, ReactDOMComponent.Mixin);
      mixInto(ReactDOMComponent, ReactMultiChild.Mixin);
      mixInto(ReactDOMComponent, ReactBrowserComponentMixin);
      
      module.exports = ReactDOMComponent;
      
      },{"./CSSPropertyOperations":4,"./DOMProperty":10,"./DOMPropertyOperations":11,"./ReactBrowserComponentMixin":28,"./ReactBrowserEventEmitter":29,"./ReactComponent":31,"./ReactMount":61,"./ReactMultiChild":62,"./ReactPerf":65,"./escapeTextForBrowser":104,"./invariant":120,"./keyOf":127,"./merge":130,"./mixInto":133}],39:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDOMForm
       */
      
      "use strict";
      
      var EventConstants = _dereq_("./EventConstants");
      var LocalEventTrapMixin = _dereq_("./LocalEventTrapMixin");
      var ReactBrowserComponentMixin = _dereq_("./ReactBrowserComponentMixin");
      var ReactCompositeComponent = _dereq_("./ReactCompositeComponent");
      var ReactDOM = _dereq_("./ReactDOM");
      
      // Store a reference to the <form> `ReactDOMComponent`.
      var form = ReactDOM.form;
      
      /**
       * Since onSubmit doesn't bubble OR capture on the top level in IE8, we need
       * to capture it on the <form> element itself. There are lots of hacks we could
       * do to accomplish this, but the most reliable is to make <form> a
       * composite component and use `componentDidMount` to attach the event handlers.
       */
      var ReactDOMForm = ReactCompositeComponent.createClass({
        displayName: 'ReactDOMForm',
      
        mixins: [ReactBrowserComponentMixin, LocalEventTrapMixin],
      
        render: function() {
          // TODO: Instead of using `ReactDOM` directly, we should use JSX. However,
          // `jshint` fails to parse JSX so in order for linting to work in the open
          // source repo, we need to just use `ReactDOM.form`.
          return this.transferPropsTo(form(null, this.props.children));
        },
      
        componentDidMount: function() {
          this.trapBubbledEvent(EventConstants.topLevelTypes.topReset, 'reset');
          this.trapBubbledEvent(EventConstants.topLevelTypes.topSubmit, 'submit');
        }
      });
      
      module.exports = ReactDOMForm;
      
      },{"./EventConstants":15,"./LocalEventTrapMixin":24,"./ReactBrowserComponentMixin":28,"./ReactCompositeComponent":33,"./ReactDOM":36}],40:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDOMIDOperations
       * @typechecks static-only
       */
      
      /*jslint evil: true */
      
      "use strict";
      
      var CSSPropertyOperations = _dereq_("./CSSPropertyOperations");
      var DOMChildrenOperations = _dereq_("./DOMChildrenOperations");
      var DOMPropertyOperations = _dereq_("./DOMPropertyOperations");
      var ReactMount = _dereq_("./ReactMount");
      var ReactPerf = _dereq_("./ReactPerf");
      
      var invariant = _dereq_("./invariant");
      var setInnerHTML = _dereq_("./setInnerHTML");
      
      /**
       * Errors for properties that should not be updated with `updatePropertyById()`.
       *
       * @type {object}
       * @private
       */
      var INVALID_PROPERTY_ERRORS = {
        dangerouslySetInnerHTML:
          '`dangerouslySetInnerHTML` must be set using `updateInnerHTMLByID()`.',
        style: '`style` must be set using `updateStylesByID()`.'
      };
      
      /**
       * Operations used to process updates to DOM nodes. This is made injectable via
       * `ReactComponent.BackendIDOperations`.
       */
      var ReactDOMIDOperations = {
      
        /**
         * Updates a DOM node with new property values. This should only be used to
         * update DOM properties in `DOMProperty`.
         *
         * @param {string} id ID of the node to update.
         * @param {string} name A valid property name, see `DOMProperty`.
         * @param {*} value New value of the property.
         * @internal
         */
        updatePropertyByID: ReactPerf.measure(
          'ReactDOMIDOperations',
          'updatePropertyByID',
          function(id, name, value) {
            var node = ReactMount.getNode(id);
            ("production" !== "development" ? invariant(
              !INVALID_PROPERTY_ERRORS.hasOwnProperty(name),
              'updatePropertyByID(...): %s',
              INVALID_PROPERTY_ERRORS[name]
            ) : invariant(!INVALID_PROPERTY_ERRORS.hasOwnProperty(name)));
      
            // If we're updating to null or undefined, we should remove the property
            // from the DOM node instead of inadvertantly setting to a string. This
            // brings us in line with the same behavior we have on initial render.
            if (value != null) {
              DOMPropertyOperations.setValueForProperty(node, name, value);
            } else {
              DOMPropertyOperations.deleteValueForProperty(node, name);
            }
          }
        ),
      
        /**
         * Updates a DOM node to remove a property. This should only be used to remove
         * DOM properties in `DOMProperty`.
         *
         * @param {string} id ID of the node to update.
         * @param {string} name A property name to remove, see `DOMProperty`.
         * @internal
         */
        deletePropertyByID: ReactPerf.measure(
          'ReactDOMIDOperations',
          'deletePropertyByID',
          function(id, name, value) {
            var node = ReactMount.getNode(id);
            ("production" !== "development" ? invariant(
              !INVALID_PROPERTY_ERRORS.hasOwnProperty(name),
              'updatePropertyByID(...): %s',
              INVALID_PROPERTY_ERRORS[name]
            ) : invariant(!INVALID_PROPERTY_ERRORS.hasOwnProperty(name)));
            DOMPropertyOperations.deleteValueForProperty(node, name, value);
          }
        ),
      
        /**
         * Updates a DOM node with new style values. If a value is specified as '',
         * the corresponding style property will be unset.
         *
         * @param {string} id ID of the node to update.
         * @param {object} styles Mapping from styles to values.
         * @internal
         */
        updateStylesByID: ReactPerf.measure(
          'ReactDOMIDOperations',
          'updateStylesByID',
          function(id, styles) {
            var node = ReactMount.getNode(id);
            CSSPropertyOperations.setValueForStyles(node, styles);
          }
        ),
      
        /**
         * Updates a DOM node's innerHTML.
         *
         * @param {string} id ID of the node to update.
         * @param {string} html An HTML string.
         * @internal
         */
        updateInnerHTMLByID: ReactPerf.measure(
          'ReactDOMIDOperations',
          'updateInnerHTMLByID',
          function(id, html) {
            var node = ReactMount.getNode(id);
            setInnerHTML(node, html);
          }
        ),
      
        /**
         * Updates a DOM node's text content set by `props.content`.
         *
         * @param {string} id ID of the node to update.
         * @param {string} content Text content.
         * @internal
         */
        updateTextContentByID: ReactPerf.measure(
          'ReactDOMIDOperations',
          'updateTextContentByID',
          function(id, content) {
            var node = ReactMount.getNode(id);
            DOMChildrenOperations.updateTextContent(node, content);
          }
        ),
      
        /**
         * Replaces a DOM node that exists in the document with markup.
         *
         * @param {string} id ID of child to be replaced.
         * @param {string} markup Dangerous markup to inject in place of child.
         * @internal
         * @see {Danger.dangerouslyReplaceNodeWithMarkup}
         */
        dangerouslyReplaceNodeWithMarkupByID: ReactPerf.measure(
          'ReactDOMIDOperations',
          'dangerouslyReplaceNodeWithMarkupByID',
          function(id, markup) {
            var node = ReactMount.getNode(id);
            DOMChildrenOperations.dangerouslyReplaceNodeWithMarkup(node, markup);
          }
        ),
      
        /**
         * Updates a component's children by processing a series of updates.
         *
         * @param {array<object>} updates List of update configurations.
         * @param {array<string>} markup List of markup strings.
         * @internal
         */
        dangerouslyProcessChildrenUpdates: ReactPerf.measure(
          'ReactDOMIDOperations',
          'dangerouslyProcessChildrenUpdates',
          function(updates, markup) {
            for (var i = 0; i < updates.length; i++) {
              updates[i].parentNode = ReactMount.getNode(updates[i].parentID);
            }
            DOMChildrenOperations.processUpdates(updates, markup);
          }
        )
      };
      
      module.exports = ReactDOMIDOperations;
      
      },{"./CSSPropertyOperations":4,"./DOMChildrenOperations":9,"./DOMPropertyOperations":11,"./ReactMount":61,"./ReactPerf":65,"./invariant":120,"./setInnerHTML":138}],41:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDOMImg
       */
      
      "use strict";
      
      var EventConstants = _dereq_("./EventConstants");
      var LocalEventTrapMixin = _dereq_("./LocalEventTrapMixin");
      var ReactBrowserComponentMixin = _dereq_("./ReactBrowserComponentMixin");
      var ReactCompositeComponent = _dereq_("./ReactCompositeComponent");
      var ReactDOM = _dereq_("./ReactDOM");
      
      // Store a reference to the <img> `ReactDOMComponent`.
      var img = ReactDOM.img;
      
      /**
       * Since onLoad doesn't bubble OR capture on the top level in IE8, we need to
       * capture it on the <img> element itself. There are lots of hacks we could do
       * to accomplish this, but the most reliable is to make <img> a composite
       * component and use `componentDidMount` to attach the event handlers.
       */
      var ReactDOMImg = ReactCompositeComponent.createClass({
        displayName: 'ReactDOMImg',
        tagName: 'IMG',
      
        mixins: [ReactBrowserComponentMixin, LocalEventTrapMixin],
      
        render: function() {
          return img(this.props);
        },
      
        componentDidMount: function() {
          this.trapBubbledEvent(EventConstants.topLevelTypes.topLoad, 'load');
          this.trapBubbledEvent(EventConstants.topLevelTypes.topError, 'error');
        }
      });
      
      module.exports = ReactDOMImg;
      
      },{"./EventConstants":15,"./LocalEventTrapMixin":24,"./ReactBrowserComponentMixin":28,"./ReactCompositeComponent":33,"./ReactDOM":36}],42:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDOMInput
       */
      
      "use strict";
      
      var AutoFocusMixin = _dereq_("./AutoFocusMixin");
      var DOMPropertyOperations = _dereq_("./DOMPropertyOperations");
      var LinkedValueUtils = _dereq_("./LinkedValueUtils");
      var ReactBrowserComponentMixin = _dereq_("./ReactBrowserComponentMixin");
      var ReactCompositeComponent = _dereq_("./ReactCompositeComponent");
      var ReactDOM = _dereq_("./ReactDOM");
      var ReactMount = _dereq_("./ReactMount");
      
      var invariant = _dereq_("./invariant");
      var merge = _dereq_("./merge");
      
      // Store a reference to the <input> `ReactDOMComponent`.
      var input = ReactDOM.input;
      
      var instancesByReactID = {};
      
      /**
       * Implements an <input> native component that allows setting these optional
       * props: `checked`, `value`, `defaultChecked`, and `defaultValue`.
       *
       * If `checked` or `value` are not supplied (or null/undefined), user actions
       * that affect the checked state or value will trigger updates to the element.
       *
       * If they are supplied (and not null/undefined), the rendered element will not
       * trigger updates to the element. Instead, the props must change in order for
       * the rendered element to be updated.
       *
       * The rendered element will be initialized as unchecked (or `defaultChecked`)
       * with an empty value (or `defaultValue`).
       *
       * @see http://www.w3.org/TR/2012/WD-html5-20121025/the-input-element.html
       */
      var ReactDOMInput = ReactCompositeComponent.createClass({
        displayName: 'ReactDOMInput',
      
        mixins: [AutoFocusMixin, LinkedValueUtils.Mixin, ReactBrowserComponentMixin],
      
        getInitialState: function() {
          var defaultValue = this.props.defaultValue;
          return {
            checked: this.props.defaultChecked || false,
            value: defaultValue != null ? defaultValue : null
          };
        },
      
        shouldComponentUpdate: function() {
          // Defer any updates to this component during the `onChange` handler.
          return !this._isChanging;
        },
      
        render: function() {
          // Clone `this.props` so we don't mutate the input.
          var props = merge(this.props);
      
          props.defaultChecked = null;
          props.defaultValue = null;
      
          var value = LinkedValueUtils.getValue(this);
          props.value = value != null ? value : this.state.value;
      
          var checked = LinkedValueUtils.getChecked(this);
          props.checked = checked != null ? checked : this.state.checked;
      
          props.onChange = this._handleChange;
      
          return input(props, this.props.children);
        },
      
        componentDidMount: function() {
          var id = ReactMount.getID(this.getDOMNode());
          instancesByReactID[id] = this;
        },
      
        componentWillUnmount: function() {
          var rootNode = this.getDOMNode();
          var id = ReactMount.getID(rootNode);
          delete instancesByReactID[id];
        },
      
        componentDidUpdate: function(prevProps, prevState, prevContext) {
          var rootNode = this.getDOMNode();
          if (this.props.checked != null) {
            DOMPropertyOperations.setValueForProperty(
              rootNode,
              'checked',
              this.props.checked || false
            );
          }
      
          var value = LinkedValueUtils.getValue(this);
          if (value != null) {
            // Cast `value` to a string to ensure the value is set correctly. While
            // browsers typically do this as necessary, jsdom doesn't.
            DOMPropertyOperations.setValueForProperty(rootNode, 'value', '' + value);
          }
        },
      
        _handleChange: function(event) {
          var returnValue;
          var onChange = LinkedValueUtils.getOnChange(this);
          if (onChange) {
            this._isChanging = true;
            returnValue = onChange.call(this, event);
            this._isChanging = false;
          }
          this.setState({
            checked: event.target.checked,
            value: event.target.value
          });
      
          var name = this.props.name;
          if (this.props.type === 'radio' && name != null) {
            var rootNode = this.getDOMNode();
            var queryRoot = rootNode;
      
            while (queryRoot.parentNode) {
              queryRoot = queryRoot.parentNode;
            }
      
            // If `rootNode.form` was non-null, then we could try `form.elements`,
            // but that sometimes behaves strangely in IE8. We could also try using
            // `form.getElementsByName`, but that will only return direct children
            // and won't include inputs that use the HTML5 `form=` attribute. Since
            // the input might not even be in a form, let's just use the global
            // `querySelectorAll` to ensure we don't miss anything.
            var group = queryRoot.querySelectorAll(
              'input[name=' + JSON.stringify('' + name) + '][type="radio"]');
      
            for (var i = 0, groupLen = group.length; i < groupLen; i++) {
              var otherNode = group[i];
              if (otherNode === rootNode ||
                  otherNode.form !== rootNode.form) {
                continue;
              }
              var otherID = ReactMount.getID(otherNode);
              ("production" !== "development" ? invariant(
                otherID,
                'ReactDOMInput: Mixing React and non-React radio inputs with the ' +
                'same `name` is not supported.'
              ) : invariant(otherID));
              var otherInstance = instancesByReactID[otherID];
              ("production" !== "development" ? invariant(
                otherInstance,
                'ReactDOMInput: Unknown radio button ID %s.',
                otherID
              ) : invariant(otherInstance));
              // In some cases, this will actually change the `checked` state value.
              // In other cases, there's no change but this forces a reconcile upon
              // which componentDidUpdate will reset the DOM property to whatever it
              // should be.
              otherInstance.setState({
                checked: false
              });
            }
          }
      
          return returnValue;
        }
      
      });
      
      module.exports = ReactDOMInput;
      
      },{"./AutoFocusMixin":1,"./DOMPropertyOperations":11,"./LinkedValueUtils":23,"./ReactBrowserComponentMixin":28,"./ReactCompositeComponent":33,"./ReactDOM":36,"./ReactMount":61,"./invariant":120,"./merge":130}],43:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDOMOption
       */
      
      "use strict";
      
      var ReactBrowserComponentMixin = _dereq_("./ReactBrowserComponentMixin");
      var ReactCompositeComponent = _dereq_("./ReactCompositeComponent");
      var ReactDOM = _dereq_("./ReactDOM");
      
      var warning = _dereq_("./warning");
      
      // Store a reference to the <option> `ReactDOMComponent`.
      var option = ReactDOM.option;
      
      /**
       * Implements an <option> native component that warns when `selected` is set.
       */
      var ReactDOMOption = ReactCompositeComponent.createClass({
        displayName: 'ReactDOMOption',
      
        mixins: [ReactBrowserComponentMixin],
      
        componentWillMount: function() {
          // TODO (yungsters): Remove support for `selected` in <option>.
          if ("production" !== "development") {
            ("production" !== "development" ? warning(
              this.props.selected == null,
              'Use the `defaultValue` or `value` props on <select> instead of ' +
              'setting `selected` on <option>.'
            ) : null);
          }
        },
      
        render: function() {
          return option(this.props, this.props.children);
        }
      
      });
      
      module.exports = ReactDOMOption;
      
      },{"./ReactBrowserComponentMixin":28,"./ReactCompositeComponent":33,"./ReactDOM":36,"./warning":143}],44:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDOMSelect
       */
      
      "use strict";
      
      var AutoFocusMixin = _dereq_("./AutoFocusMixin");
      var LinkedValueUtils = _dereq_("./LinkedValueUtils");
      var ReactBrowserComponentMixin = _dereq_("./ReactBrowserComponentMixin");
      var ReactCompositeComponent = _dereq_("./ReactCompositeComponent");
      var ReactDOM = _dereq_("./ReactDOM");
      
      var merge = _dereq_("./merge");
      
      // Store a reference to the <select> `ReactDOMComponent`.
      var select = ReactDOM.select;
      
      /**
       * Validation function for `value` and `defaultValue`.
       * @private
       */
      function selectValueType(props, propName, componentName) {
        if (props[propName] == null) {
          return;
        }
        if (props.multiple) {
          if (!Array.isArray(props[propName])) {
            return new Error(
              ("The `" + propName + "` prop supplied to <select> must be an array if ") +
              ("`multiple` is true.")
            );
          }
        } else {
          if (Array.isArray(props[propName])) {
            return new Error(
              ("The `" + propName + "` prop supplied to <select> must be a scalar ") +
              ("value if `multiple` is false.")
            );
          }
        }
      }
      
      /**
       * If `value` is supplied, updates <option> elements on mount and update.
       * @param {ReactComponent} component Instance of ReactDOMSelect
       * @param {?*} propValue For uncontrolled components, null/undefined. For
       * controlled components, a string (or with `multiple`, a list of strings).
       * @private
       */
      function updateOptions(component, propValue) {
        var multiple = component.props.multiple;
        var value = propValue != null ? propValue : component.state.value;
        var options = component.getDOMNode().options;
        var selectedValue, i, l;
        if (multiple) {
          selectedValue = {};
          for (i = 0, l = value.length; i < l; ++i) {
            selectedValue['' + value[i]] = true;
          }
        } else {
          selectedValue = '' + value;
        }
        for (i = 0, l = options.length; i < l; i++) {
          var selected = multiple ?
            selectedValue.hasOwnProperty(options[i].value) :
            options[i].value === selectedValue;
      
          if (selected !== options[i].selected) {
            options[i].selected = selected;
          }
        }
      }
      
      /**
       * Implements a <select> native component that allows optionally setting the
       * props `value` and `defaultValue`. If `multiple` is false, the prop must be a
       * string. If `multiple` is true, the prop must be an array of strings.
       *
       * If `value` is not supplied (or null/undefined), user actions that change the
       * selected option will trigger updates to the rendered options.
       *
       * If it is supplied (and not null/undefined), the rendered options will not
       * update in response to user actions. Instead, the `value` prop must change in
       * order for the rendered options to update.
       *
       * If `defaultValue` is provided, any options with the supplied values will be
       * selected.
       */
      var ReactDOMSelect = ReactCompositeComponent.createClass({
        displayName: 'ReactDOMSelect',
      
        mixins: [AutoFocusMixin, LinkedValueUtils.Mixin, ReactBrowserComponentMixin],
      
        propTypes: {
          defaultValue: selectValueType,
          value: selectValueType
        },
      
        getInitialState: function() {
          return {value: this.props.defaultValue || (this.props.multiple ? [] : '')};
        },
      
        componentWillReceiveProps: function(nextProps) {
          if (!this.props.multiple && nextProps.multiple) {
            this.setState({value: [this.state.value]});
          } else if (this.props.multiple && !nextProps.multiple) {
            this.setState({value: this.state.value[0]});
          }
        },
      
        shouldComponentUpdate: function() {
          // Defer any updates to this component during the `onChange` handler.
          return !this._isChanging;
        },
      
        render: function() {
          // Clone `this.props` so we don't mutate the input.
          var props = merge(this.props);
      
          props.onChange = this._handleChange;
          props.value = null;
      
          return select(props, this.props.children);
        },
      
        componentDidMount: function() {
          updateOptions(this, LinkedValueUtils.getValue(this));
        },
      
        componentDidUpdate: function(prevProps) {
          var value = LinkedValueUtils.getValue(this);
          var prevMultiple = !!prevProps.multiple;
          var multiple = !!this.props.multiple;
          if (value != null || prevMultiple !== multiple) {
            updateOptions(this, value);
          }
        },
      
        _handleChange: function(event) {
          var returnValue;
          var onChange = LinkedValueUtils.getOnChange(this);
          if (onChange) {
            this._isChanging = true;
            returnValue = onChange.call(this, event);
            this._isChanging = false;
          }
      
          var selectedValue;
          if (this.props.multiple) {
            selectedValue = [];
            var options = event.target.options;
            for (var i = 0, l = options.length; i < l; i++) {
              if (options[i].selected) {
                selectedValue.push(options[i].value);
              }
            }
          } else {
            selectedValue = event.target.value;
          }
      
          this.setState({value: selectedValue});
          return returnValue;
        }
      
      });
      
      module.exports = ReactDOMSelect;
      
      },{"./AutoFocusMixin":1,"./LinkedValueUtils":23,"./ReactBrowserComponentMixin":28,"./ReactCompositeComponent":33,"./ReactDOM":36,"./merge":130}],45:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDOMSelection
       */
      
      "use strict";
      
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      
      var getNodeForCharacterOffset = _dereq_("./getNodeForCharacterOffset");
      var getTextContentAccessor = _dereq_("./getTextContentAccessor");
      
      /**
       * While `isCollapsed` is available on the Selection object and `collapsed`
       * is available on the Range object, IE11 sometimes gets them wrong.
       * If the anchor/focus nodes and offsets are the same, the range is collapsed.
       */
      function isCollapsed(anchorNode, anchorOffset, focusNode, focusOffset) {
        return anchorNode === focusNode && anchorOffset === focusOffset;
      }
      
      /**
       * Get the appropriate anchor and focus node/offset pairs for IE.
       *
       * The catch here is that IE's selection API doesn't provide information
       * about whether the selection is forward or backward, so we have to
       * behave as though it's always forward.
       *
       * IE text differs from modern selection in that it behaves as though
       * block elements end with a new line. This means character offsets will
       * differ between the two APIs.
       *
       * @param {DOMElement} node
       * @return {object}
       */
      function getIEOffsets(node) {
        var selection = document.selection;
        var selectedRange = selection.createRange();
        var selectedLength = selectedRange.text.length;
      
        // Duplicate selection so we can move range without breaking user selection.
        var fromStart = selectedRange.duplicate();
        fromStart.moveToElementText(node);
        fromStart.setEndPoint('EndToStart', selectedRange);
      
        var startOffset = fromStart.text.length;
        var endOffset = startOffset + selectedLength;
      
        return {
          start: startOffset,
          end: endOffset
        };
      }
      
      /**
       * @param {DOMElement} node
       * @return {?object}
       */
      function getModernOffsets(node) {
        var selection = window.getSelection();
      
        if (selection.rangeCount === 0) {
          return null;
        }
      
        var anchorNode = selection.anchorNode;
        var anchorOffset = selection.anchorOffset;
        var focusNode = selection.focusNode;
        var focusOffset = selection.focusOffset;
      
        var currentRange = selection.getRangeAt(0);
      
        // If the node and offset values are the same, the selection is collapsed.
        // `Selection.isCollapsed` is available natively, but IE sometimes gets
        // this value wrong.
        var isSelectionCollapsed = isCollapsed(
          selection.anchorNode,
          selection.anchorOffset,
          selection.focusNode,
          selection.focusOffset
        );
      
        var rangeLength = isSelectionCollapsed ? 0 : currentRange.toString().length;
      
        var tempRange = currentRange.cloneRange();
        tempRange.selectNodeContents(node);
        tempRange.setEnd(currentRange.startContainer, currentRange.startOffset);
      
        var isTempRangeCollapsed = isCollapsed(
          tempRange.startContainer,
          tempRange.startOffset,
          tempRange.endContainer,
          tempRange.endOffset
        );
      
        var start = isTempRangeCollapsed ? 0 : tempRange.toString().length;
        var end = start + rangeLength;
      
        // Detect whether the selection is backward.
        var detectionRange = document.createRange();
        detectionRange.setStart(anchorNode, anchorOffset);
        detectionRange.setEnd(focusNode, focusOffset);
        var isBackward = detectionRange.collapsed;
        detectionRange.detach();
      
        return {
          start: isBackward ? end : start,
          end: isBackward ? start : end
        };
      }
      
      /**
       * @param {DOMElement|DOMTextNode} node
       * @param {object} offsets
       */
      function setIEOffsets(node, offsets) {
        var range = document.selection.createRange().duplicate();
        var start, end;
      
        if (typeof offsets.end === 'undefined') {
          start = offsets.start;
          end = start;
        } else if (offsets.start > offsets.end) {
          start = offsets.end;
          end = offsets.start;
        } else {
          start = offsets.start;
          end = offsets.end;
        }
      
        range.moveToElementText(node);
        range.moveStart('character', start);
        range.setEndPoint('EndToStart', range);
        range.moveEnd('character', end - start);
        range.select();
      }
      
      /**
       * In modern non-IE browsers, we can support both forward and backward
       * selections.
       *
       * Note: IE10+ supports the Selection object, but it does not support
       * the `extend` method, which means that even in modern IE, it's not possible
       * to programatically create a backward selection. Thus, for all IE
       * versions, we use the old IE API to create our selections.
       *
       * @param {DOMElement|DOMTextNode} node
       * @param {object} offsets
       */
      function setModernOffsets(node, offsets) {
        var selection = window.getSelection();
      
        var length = node[getTextContentAccessor()].length;
        var start = Math.min(offsets.start, length);
        var end = typeof offsets.end === 'undefined' ?
                  start : Math.min(offsets.end, length);
      
        // IE 11 uses modern selection, but doesn't support the extend method.
        // Flip backward selections, so we can set with a single range.
        if (!selection.extend && start > end) {
          var temp = end;
          end = start;
          start = temp;
        }
      
        var startMarker = getNodeForCharacterOffset(node, start);
        var endMarker = getNodeForCharacterOffset(node, end);
      
        if (startMarker && endMarker) {
          var range = document.createRange();
          range.setStart(startMarker.node, startMarker.offset);
          selection.removeAllRanges();
      
          if (start > end) {
            selection.addRange(range);
            selection.extend(endMarker.node, endMarker.offset);
          } else {
            range.setEnd(endMarker.node, endMarker.offset);
            selection.addRange(range);
          }
      
          range.detach();
        }
      }
      
      var useIEOffsets = ExecutionEnvironment.canUseDOM && document.selection;
      
      var ReactDOMSelection = {
        /**
         * @param {DOMElement} node
         */
        getOffsets: useIEOffsets ? getIEOffsets : getModernOffsets,
      
        /**
         * @param {DOMElement|DOMTextNode} node
         * @param {object} offsets
         */
        setOffsets: useIEOffsets ? setIEOffsets : setModernOffsets
      };
      
      module.exports = ReactDOMSelection;
      
      },{"./ExecutionEnvironment":21,"./getNodeForCharacterOffset":113,"./getTextContentAccessor":115}],46:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDOMTextarea
       */
      
      "use strict";
      
      var AutoFocusMixin = _dereq_("./AutoFocusMixin");
      var DOMPropertyOperations = _dereq_("./DOMPropertyOperations");
      var LinkedValueUtils = _dereq_("./LinkedValueUtils");
      var ReactBrowserComponentMixin = _dereq_("./ReactBrowserComponentMixin");
      var ReactCompositeComponent = _dereq_("./ReactCompositeComponent");
      var ReactDOM = _dereq_("./ReactDOM");
      
      var invariant = _dereq_("./invariant");
      var merge = _dereq_("./merge");
      
      var warning = _dereq_("./warning");
      
      // Store a reference to the <textarea> `ReactDOMComponent`.
      var textarea = ReactDOM.textarea;
      
      /**
       * Implements a <textarea> native component that allows setting `value`, and
       * `defaultValue`. This differs from the traditional DOM API because value is
       * usually set as PCDATA children.
       *
       * If `value` is not supplied (or null/undefined), user actions that affect the
       * value will trigger updates to the element.
       *
       * If `value` is supplied (and not null/undefined), the rendered element will
       * not trigger updates to the element. Instead, the `value` prop must change in
       * order for the rendered element to be updated.
       *
       * The rendered element will be initialized with an empty value, the prop
       * `defaultValue` if specified, or the children content (deprecated).
       */
      var ReactDOMTextarea = ReactCompositeComponent.createClass({
        displayName: 'ReactDOMTextarea',
      
        mixins: [AutoFocusMixin, LinkedValueUtils.Mixin, ReactBrowserComponentMixin],
      
        getInitialState: function() {
          var defaultValue = this.props.defaultValue;
          // TODO (yungsters): Remove support for children content in <textarea>.
          var children = this.props.children;
          if (children != null) {
            if ("production" !== "development") {
              ("production" !== "development" ? warning(
                false,
                'Use the `defaultValue` or `value` props instead of setting ' +
                'children on <textarea>.'
              ) : null);
            }
            ("production" !== "development" ? invariant(
              defaultValue == null,
              'If you supply `defaultValue` on a <textarea>, do not pass children.'
            ) : invariant(defaultValue == null));
            if (Array.isArray(children)) {
              ("production" !== "development" ? invariant(
                children.length <= 1,
                '<textarea> can only have at most one child.'
              ) : invariant(children.length <= 1));
              children = children[0];
            }
      
            defaultValue = '' + children;
          }
          if (defaultValue == null) {
            defaultValue = '';
          }
          var value = LinkedValueUtils.getValue(this);
          return {
            // We save the initial value so that `ReactDOMComponent` doesn't update
            // `textContent` (unnecessary since we update value).
            // The initial value can be a boolean or object so that's why it's
            // forced to be a string.
            initialValue: '' + (value != null ? value : defaultValue)
          };
        },
      
        shouldComponentUpdate: function() {
          // Defer any updates to this component during the `onChange` handler.
          return !this._isChanging;
        },
      
        render: function() {
          // Clone `this.props` so we don't mutate the input.
          var props = merge(this.props);
      
          ("production" !== "development" ? invariant(
            props.dangerouslySetInnerHTML == null,
            '`dangerouslySetInnerHTML` does not make sense on <textarea>.'
          ) : invariant(props.dangerouslySetInnerHTML == null));
      
          props.defaultValue = null;
          props.value = null;
          props.onChange = this._handleChange;
      
          // Always set children to the same thing. In IE9, the selection range will
          // get reset if `textContent` is mutated.
          return textarea(props, this.state.initialValue);
        },
      
        componentDidUpdate: function(prevProps, prevState, prevContext) {
          var value = LinkedValueUtils.getValue(this);
          if (value != null) {
            var rootNode = this.getDOMNode();
            // Cast `value` to a string to ensure the value is set correctly. While
            // browsers typically do this as necessary, jsdom doesn't.
            DOMPropertyOperations.setValueForProperty(rootNode, 'value', '' + value);
          }
        },
      
        _handleChange: function(event) {
          var returnValue;
          var onChange = LinkedValueUtils.getOnChange(this);
          if (onChange) {
            this._isChanging = true;
            returnValue = onChange.call(this, event);
            this._isChanging = false;
          }
          this.setState({value: event.target.value});
          return returnValue;
        }
      
      });
      
      module.exports = ReactDOMTextarea;
      
      },{"./AutoFocusMixin":1,"./DOMPropertyOperations":11,"./LinkedValueUtils":23,"./ReactBrowserComponentMixin":28,"./ReactCompositeComponent":33,"./ReactDOM":36,"./invariant":120,"./merge":130,"./warning":143}],47:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDefaultBatchingStrategy
       */
      
      "use strict";
      
      var ReactUpdates = _dereq_("./ReactUpdates");
      var Transaction = _dereq_("./Transaction");
      
      var emptyFunction = _dereq_("./emptyFunction");
      var mixInto = _dereq_("./mixInto");
      
      var RESET_BATCHED_UPDATES = {
        initialize: emptyFunction,
        close: function() {
          ReactDefaultBatchingStrategy.isBatchingUpdates = false;
        }
      };
      
      var FLUSH_BATCHED_UPDATES = {
        initialize: emptyFunction,
        close: ReactUpdates.flushBatchedUpdates.bind(ReactUpdates)
      };
      
      var TRANSACTION_WRAPPERS = [FLUSH_BATCHED_UPDATES, RESET_BATCHED_UPDATES];
      
      function ReactDefaultBatchingStrategyTransaction() {
        this.reinitializeTransaction();
      }
      
      mixInto(ReactDefaultBatchingStrategyTransaction, Transaction.Mixin);
      mixInto(ReactDefaultBatchingStrategyTransaction, {
        getTransactionWrappers: function() {
          return TRANSACTION_WRAPPERS;
        }
      });
      
      var transaction = new ReactDefaultBatchingStrategyTransaction();
      
      var ReactDefaultBatchingStrategy = {
        isBatchingUpdates: false,
      
        /**
         * Call the provided function in a context within which calls to `setState`
         * and friends are batched such that components aren't updated unnecessarily.
         */
        batchedUpdates: function(callback, a, b) {
          var alreadyBatchingUpdates = ReactDefaultBatchingStrategy.isBatchingUpdates;
      
          ReactDefaultBatchingStrategy.isBatchingUpdates = true;
      
          // The code is written this way to avoid extra allocations
          if (alreadyBatchingUpdates) {
            callback(a, b);
          } else {
            transaction.perform(callback, null, a, b);
          }
        }
      };
      
      module.exports = ReactDefaultBatchingStrategy;
      
      },{"./ReactUpdates":76,"./Transaction":92,"./emptyFunction":102,"./mixInto":133}],48:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDefaultInjection
       */
      
      "use strict";
      
      var BeforeInputEventPlugin = _dereq_("./BeforeInputEventPlugin");
      var ChangeEventPlugin = _dereq_("./ChangeEventPlugin");
      var ClientReactRootIndex = _dereq_("./ClientReactRootIndex");
      var CompositionEventPlugin = _dereq_("./CompositionEventPlugin");
      var DefaultEventPluginOrder = _dereq_("./DefaultEventPluginOrder");
      var EnterLeaveEventPlugin = _dereq_("./EnterLeaveEventPlugin");
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      var HTMLDOMPropertyConfig = _dereq_("./HTMLDOMPropertyConfig");
      var MobileSafariClickEventPlugin = _dereq_("./MobileSafariClickEventPlugin");
      var ReactBrowserComponentMixin = _dereq_("./ReactBrowserComponentMixin");
      var ReactComponentBrowserEnvironment =
        _dereq_("./ReactComponentBrowserEnvironment");
      var ReactDefaultBatchingStrategy = _dereq_("./ReactDefaultBatchingStrategy");
      var ReactDOM = _dereq_("./ReactDOM");
      var ReactDOMButton = _dereq_("./ReactDOMButton");
      var ReactDOMForm = _dereq_("./ReactDOMForm");
      var ReactDOMImg = _dereq_("./ReactDOMImg");
      var ReactDOMInput = _dereq_("./ReactDOMInput");
      var ReactDOMOption = _dereq_("./ReactDOMOption");
      var ReactDOMSelect = _dereq_("./ReactDOMSelect");
      var ReactDOMTextarea = _dereq_("./ReactDOMTextarea");
      var ReactEventListener = _dereq_("./ReactEventListener");
      var ReactInjection = _dereq_("./ReactInjection");
      var ReactInstanceHandles = _dereq_("./ReactInstanceHandles");
      var ReactMount = _dereq_("./ReactMount");
      var SelectEventPlugin = _dereq_("./SelectEventPlugin");
      var ServerReactRootIndex = _dereq_("./ServerReactRootIndex");
      var SimpleEventPlugin = _dereq_("./SimpleEventPlugin");
      var SVGDOMPropertyConfig = _dereq_("./SVGDOMPropertyConfig");
      
      var createFullPageComponent = _dereq_("./createFullPageComponent");
      
      function inject() {
        ReactInjection.EventEmitter.injectReactEventListener(
          ReactEventListener
        );
      
        /**
         * Inject modules for resolving DOM hierarchy and plugin ordering.
         */
        ReactInjection.EventPluginHub.injectEventPluginOrder(DefaultEventPluginOrder);
        ReactInjection.EventPluginHub.injectInstanceHandle(ReactInstanceHandles);
        ReactInjection.EventPluginHub.injectMount(ReactMount);
      
        /**
         * Some important event plugins included by default (without having to require
         * them).
         */
        ReactInjection.EventPluginHub.injectEventPluginsByName({
          SimpleEventPlugin: SimpleEventPlugin,
          EnterLeaveEventPlugin: EnterLeaveEventPlugin,
          ChangeEventPlugin: ChangeEventPlugin,
          CompositionEventPlugin: CompositionEventPlugin,
          MobileSafariClickEventPlugin: MobileSafariClickEventPlugin,
          SelectEventPlugin: SelectEventPlugin,
          BeforeInputEventPlugin: BeforeInputEventPlugin
        });
      
        ReactInjection.DOM.injectComponentClasses({
          button: ReactDOMButton,
          form: ReactDOMForm,
          img: ReactDOMImg,
          input: ReactDOMInput,
          option: ReactDOMOption,
          select: ReactDOMSelect,
          textarea: ReactDOMTextarea,
      
          html: createFullPageComponent(ReactDOM.html),
          head: createFullPageComponent(ReactDOM.head),
          body: createFullPageComponent(ReactDOM.body)
        });
      
        // This needs to happen after createFullPageComponent() otherwise the mixin
        // gets double injected.
        ReactInjection.CompositeComponent.injectMixin(ReactBrowserComponentMixin);
      
        ReactInjection.DOMProperty.injectDOMPropertyConfig(HTMLDOMPropertyConfig);
        ReactInjection.DOMProperty.injectDOMPropertyConfig(SVGDOMPropertyConfig);
      
        ReactInjection.EmptyComponent.injectEmptyComponent(ReactDOM.noscript);
      
        ReactInjection.Updates.injectReconcileTransaction(
          ReactComponentBrowserEnvironment.ReactReconcileTransaction
        );
        ReactInjection.Updates.injectBatchingStrategy(
          ReactDefaultBatchingStrategy
        );
      
        ReactInjection.RootIndex.injectCreateReactRootIndex(
          ExecutionEnvironment.canUseDOM ?
            ClientReactRootIndex.createReactRootIndex :
            ServerReactRootIndex.createReactRootIndex
        );
      
        ReactInjection.Component.injectEnvironment(ReactComponentBrowserEnvironment);
      
        if ("production" !== "development") {
          var url = (ExecutionEnvironment.canUseDOM && window.location.href) || '';
          if ((/[?&]react_perf\b/).test(url)) {
            var ReactDefaultPerf = _dereq_("./ReactDefaultPerf");
            ReactDefaultPerf.start();
          }
        }
      }
      
      module.exports = {
        inject: inject
      };
      
      },{"./BeforeInputEventPlugin":2,"./ChangeEventPlugin":6,"./ClientReactRootIndex":7,"./CompositionEventPlugin":8,"./DefaultEventPluginOrder":13,"./EnterLeaveEventPlugin":14,"./ExecutionEnvironment":21,"./HTMLDOMPropertyConfig":22,"./MobileSafariClickEventPlugin":25,"./ReactBrowserComponentMixin":28,"./ReactComponentBrowserEnvironment":32,"./ReactDOM":36,"./ReactDOMButton":37,"./ReactDOMForm":39,"./ReactDOMImg":41,"./ReactDOMInput":42,"./ReactDOMOption":43,"./ReactDOMSelect":44,"./ReactDOMTextarea":46,"./ReactDefaultBatchingStrategy":47,"./ReactDefaultPerf":49,"./ReactEventListener":56,"./ReactInjection":57,"./ReactInstanceHandles":59,"./ReactMount":61,"./SVGDOMPropertyConfig":77,"./SelectEventPlugin":78,"./ServerReactRootIndex":79,"./SimpleEventPlugin":80,"./createFullPageComponent":99}],49:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDefaultPerf
       * @typechecks static-only
       */
      
      "use strict";
      
      var DOMProperty = _dereq_("./DOMProperty");
      var ReactDefaultPerfAnalysis = _dereq_("./ReactDefaultPerfAnalysis");
      var ReactMount = _dereq_("./ReactMount");
      var ReactPerf = _dereq_("./ReactPerf");
      
      var performanceNow = _dereq_("./performanceNow");
      
      function roundFloat(val) {
        return Math.floor(val * 100) / 100;
      }
      
      function addValue(obj, key, val) {
        obj[key] = (obj[key] || 0) + val;
      }
      
      var ReactDefaultPerf = {
        _allMeasurements: [], // last item in the list is the current one
        _mountStack: [0],
        _injected: false,
      
        start: function() {
          if (!ReactDefaultPerf._injected) {
            ReactPerf.injection.injectMeasure(ReactDefaultPerf.measure);
          }
      
          ReactDefaultPerf._allMeasurements.length = 0;
          ReactPerf.enableMeasure = true;
        },
      
        stop: function() {
          ReactPerf.enableMeasure = false;
        },
      
        getLastMeasurements: function() {
          return ReactDefaultPerf._allMeasurements;
        },
      
        printExclusive: function(measurements) {
          measurements = measurements || ReactDefaultPerf._allMeasurements;
          var summary = ReactDefaultPerfAnalysis.getExclusiveSummary(measurements);
          console.table(summary.map(function(item) {
            return {
              'Component class name': item.componentName,
              'Total inclusive time (ms)': roundFloat(item.inclusive),
              'Exclusive mount time (ms)': roundFloat(item.exclusive),
              'Exclusive render time (ms)': roundFloat(item.render),
              'Mount time per instance (ms)': roundFloat(item.exclusive / item.count),
              'Render time per instance (ms)': roundFloat(item.render / item.count),
              'Instances': item.count
            };
          }));
          // TODO: ReactDefaultPerfAnalysis.getTotalTime() does not return the correct
          // number.
        },
      
        printInclusive: function(measurements) {
          measurements = measurements || ReactDefaultPerf._allMeasurements;
          var summary = ReactDefaultPerfAnalysis.getInclusiveSummary(measurements);
          console.table(summary.map(function(item) {
            return {
              'Owner > component': item.componentName,
              'Inclusive time (ms)': roundFloat(item.time),
              'Instances': item.count
            };
          }));
          console.log(
            'Total time:',
            ReactDefaultPerfAnalysis.getTotalTime(measurements).toFixed(2) + ' ms'
          );
        },
      
        printWasted: function(measurements) {
          measurements = measurements || ReactDefaultPerf._allMeasurements;
          var summary = ReactDefaultPerfAnalysis.getInclusiveSummary(
            measurements,
            true
          );
          console.table(summary.map(function(item) {
            return {
              'Owner > component': item.componentName,
              'Wasted time (ms)': item.time,
              'Instances': item.count
            };
          }));
          console.log(
            'Total time:',
            ReactDefaultPerfAnalysis.getTotalTime(measurements).toFixed(2) + ' ms'
          );
        },
      
        printDOM: function(measurements) {
          measurements = measurements || ReactDefaultPerf._allMeasurements;
          var summary = ReactDefaultPerfAnalysis.getDOMSummary(measurements);
          console.table(summary.map(function(item) {
            var result = {};
            result[DOMProperty.ID_ATTRIBUTE_NAME] = item.id;
            result['type'] = item.type;
            result['args'] = JSON.stringify(item.args);
            return result;
          }));
          console.log(
            'Total time:',
            ReactDefaultPerfAnalysis.getTotalTime(measurements).toFixed(2) + ' ms'
          );
        },
      
        _recordWrite: function(id, fnName, totalTime, args) {
          // TODO: totalTime isn't that useful since it doesn't count paints/reflows
          var writes =
            ReactDefaultPerf
              ._allMeasurements[ReactDefaultPerf._allMeasurements.length - 1]
              .writes;
          writes[id] = writes[id] || [];
          writes[id].push({
            type: fnName,
            time: totalTime,
            args: args
          });
        },
      
        measure: function(moduleName, fnName, func) {
          return function() {var args=Array.prototype.slice.call(arguments,0);
            var totalTime;
            var rv;
            var start;
      
            if (fnName === '_renderNewRootComponent' ||
                fnName === 'flushBatchedUpdates') {
              // A "measurement" is a set of metrics recorded for each flush. We want
              // to group the metrics for a given flush together so we can look at the
              // components that rendered and the DOM operations that actually
              // happened to determine the amount of "wasted work" performed.
              ReactDefaultPerf._allMeasurements.push({
                exclusive: {},
                inclusive: {},
                render: {},
                counts: {},
                writes: {},
                displayNames: {},
                totalTime: 0
              });
              start = performanceNow();
              rv = func.apply(this, args);
              ReactDefaultPerf._allMeasurements[
                ReactDefaultPerf._allMeasurements.length - 1
              ].totalTime = performanceNow() - start;
              return rv;
            } else if (moduleName === 'ReactDOMIDOperations' ||
              moduleName === 'ReactComponentBrowserEnvironment') {
              start = performanceNow();
              rv = func.apply(this, args);
              totalTime = performanceNow() - start;
      
              if (fnName === 'mountImageIntoNode') {
                var mountID = ReactMount.getID(args[1]);
                ReactDefaultPerf._recordWrite(mountID, fnName, totalTime, args[0]);
              } else if (fnName === 'dangerouslyProcessChildrenUpdates') {
                // special format
                args[0].forEach(function(update) {
                  var writeArgs = {};
                  if (update.fromIndex !== null) {
                    writeArgs.fromIndex = update.fromIndex;
                  }
                  if (update.toIndex !== null) {
                    writeArgs.toIndex = update.toIndex;
                  }
                  if (update.textContent !== null) {
                    writeArgs.textContent = update.textContent;
                  }
                  if (update.markupIndex !== null) {
                    writeArgs.markup = args[1][update.markupIndex];
                  }
                  ReactDefaultPerf._recordWrite(
                    update.parentID,
                    update.type,
                    totalTime,
                    writeArgs
                  );
                });
              } else {
                // basic format
                ReactDefaultPerf._recordWrite(
                  args[0],
                  fnName,
                  totalTime,
                  Array.prototype.slice.call(args, 1)
                );
              }
              return rv;
            } else if (moduleName === 'ReactCompositeComponent' && (
              fnName === 'mountComponent' ||
              fnName === 'updateComponent' || // TODO: receiveComponent()?
              fnName === '_renderValidatedComponent')) {
      
              var rootNodeID = fnName === 'mountComponent' ?
                args[0] :
                this._rootNodeID;
              var isRender = fnName === '_renderValidatedComponent';
              var isMount = fnName === 'mountComponent';
      
              var mountStack = ReactDefaultPerf._mountStack;
              var entry = ReactDefaultPerf._allMeasurements[
                ReactDefaultPerf._allMeasurements.length - 1
              ];
      
              if (isRender) {
                addValue(entry.counts, rootNodeID, 1);
              } else if (isMount) {
                mountStack.push(0);
              }
      
              start = performanceNow();
              rv = func.apply(this, args);
              totalTime = performanceNow() - start;
      
              if (isRender) {
                addValue(entry.render, rootNodeID, totalTime);
              } else if (isMount) {
                var subMountTime = mountStack.pop();
                mountStack[mountStack.length - 1] += totalTime;
                addValue(entry.exclusive, rootNodeID, totalTime - subMountTime);
                addValue(entry.inclusive, rootNodeID, totalTime);
              } else {
                addValue(entry.inclusive, rootNodeID, totalTime);
              }
      
              entry.displayNames[rootNodeID] = {
                current: this.constructor.displayName,
                owner: this._owner ? this._owner.constructor.displayName : '<root>'
              };
      
              return rv;
            } else {
              return func.apply(this, args);
            }
          };
        }
      };
      
      module.exports = ReactDefaultPerf;
      
      },{"./DOMProperty":10,"./ReactDefaultPerfAnalysis":50,"./ReactMount":61,"./ReactPerf":65,"./performanceNow":137}],50:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDefaultPerfAnalysis
       */
      
      var merge = _dereq_("./merge");
      
      // Don't try to save users less than 1.2ms (a number I made up)
      var DONT_CARE_THRESHOLD = 1.2;
      var DOM_OPERATION_TYPES = {
        'mountImageIntoNode': 'set innerHTML',
        INSERT_MARKUP: 'set innerHTML',
        MOVE_EXISTING: 'move',
        REMOVE_NODE: 'remove',
        TEXT_CONTENT: 'set textContent',
        'updatePropertyByID': 'update attribute',
        'deletePropertyByID': 'delete attribute',
        'updateStylesByID': 'update styles',
        'updateInnerHTMLByID': 'set innerHTML',
        'dangerouslyReplaceNodeWithMarkupByID': 'replace'
      };
      
      function getTotalTime(measurements) {
        // TODO: return number of DOM ops? could be misleading.
        // TODO: measure dropped frames after reconcile?
        // TODO: log total time of each reconcile and the top-level component
        // class that triggered it.
        var totalTime = 0;
        for (var i = 0; i < measurements.length; i++) {
          var measurement = measurements[i];
          totalTime += measurement.totalTime;
        }
        return totalTime;
      }
      
      function getDOMSummary(measurements) {
        var items = [];
        for (var i = 0; i < measurements.length; i++) {
          var measurement = measurements[i];
          var id;
      
          for (id in measurement.writes) {
            measurement.writes[id].forEach(function(write) {
              items.push({
                id: id,
                type: DOM_OPERATION_TYPES[write.type] || write.type,
                args: write.args
              });
            });
          }
        }
        return items;
      }
      
      function getExclusiveSummary(measurements) {
        var candidates = {};
        var displayName;
      
        for (var i = 0; i < measurements.length; i++) {
          var measurement = measurements[i];
          var allIDs = merge(measurement.exclusive, measurement.inclusive);
      
          for (var id in allIDs) {
            displayName = measurement.displayNames[id].current;
      
            candidates[displayName] = candidates[displayName] || {
              componentName: displayName,
              inclusive: 0,
              exclusive: 0,
              render: 0,
              count: 0
            };
            if (measurement.render[id]) {
              candidates[displayName].render += measurement.render[id];
            }
            if (measurement.exclusive[id]) {
              candidates[displayName].exclusive += measurement.exclusive[id];
            }
            if (measurement.inclusive[id]) {
              candidates[displayName].inclusive += measurement.inclusive[id];
            }
            if (measurement.counts[id]) {
              candidates[displayName].count += measurement.counts[id];
            }
          }
        }
      
        // Now make a sorted array with the results.
        var arr = [];
        for (displayName in candidates) {
          if (candidates[displayName].exclusive >= DONT_CARE_THRESHOLD) {
            arr.push(candidates[displayName]);
          }
        }
      
        arr.sort(function(a, b) {
          return b.exclusive - a.exclusive;
        });
      
        return arr;
      }
      
      function getInclusiveSummary(measurements, onlyClean) {
        var candidates = {};
        var inclusiveKey;
      
        for (var i = 0; i < measurements.length; i++) {
          var measurement = measurements[i];
          var allIDs = merge(measurement.exclusive, measurement.inclusive);
          var cleanComponents;
      
          if (onlyClean) {
            cleanComponents = getUnchangedComponents(measurement);
          }
      
          for (var id in allIDs) {
            if (onlyClean && !cleanComponents[id]) {
              continue;
            }
      
            var displayName = measurement.displayNames[id];
      
            // Inclusive time is not useful for many components without knowing where
            // they are instantiated. So we aggregate inclusive time with both the
            // owner and current displayName as the key.
            inclusiveKey = displayName.owner + ' > ' + displayName.current;
      
            candidates[inclusiveKey] = candidates[inclusiveKey] || {
              componentName: inclusiveKey,
              time: 0,
              count: 0
            };
      
            if (measurement.inclusive[id]) {
              candidates[inclusiveKey].time += measurement.inclusive[id];
            }
            if (measurement.counts[id]) {
              candidates[inclusiveKey].count += measurement.counts[id];
            }
          }
        }
      
        // Now make a sorted array with the results.
        var arr = [];
        for (inclusiveKey in candidates) {
          if (candidates[inclusiveKey].time >= DONT_CARE_THRESHOLD) {
            arr.push(candidates[inclusiveKey]);
          }
        }
      
        arr.sort(function(a, b) {
          return b.time - a.time;
        });
      
        return arr;
      }
      
      function getUnchangedComponents(measurement) {
        // For a given reconcile, look at which components did not actually
        // render anything to the DOM and return a mapping of their ID to
        // the amount of time it took to render the entire subtree.
        var cleanComponents = {};
        var dirtyLeafIDs = Object.keys(measurement.writes);
        var allIDs = merge(measurement.exclusive, measurement.inclusive);
      
        for (var id in allIDs) {
          var isDirty = false;
          // For each component that rendered, see if a component that triggerd
          // a DOM op is in its subtree.
          for (var i = 0; i < dirtyLeafIDs.length; i++) {
            if (dirtyLeafIDs[i].indexOf(id) === 0) {
              isDirty = true;
              break;
            }
          }
          if (!isDirty && measurement.counts[id] > 0) {
            cleanComponents[id] = true;
          }
        }
        return cleanComponents;
      }
      
      var ReactDefaultPerfAnalysis = {
        getExclusiveSummary: getExclusiveSummary,
        getInclusiveSummary: getInclusiveSummary,
        getDOMSummary: getDOMSummary,
        getTotalTime: getTotalTime
      };
      
      module.exports = ReactDefaultPerfAnalysis;
      
      },{"./merge":130}],51:[function(_dereq_,module,exports){
      /**
       * Copyright 2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDescriptor
       */
      
      "use strict";
      
      var ReactContext = _dereq_("./ReactContext");
      var ReactCurrentOwner = _dereq_("./ReactCurrentOwner");
      
      var merge = _dereq_("./merge");
      var warning = _dereq_("./warning");
      
      /**
       * Warn for mutations.
       *
       * @internal
       * @param {object} object
       * @param {string} key
       */
      function defineWarningProperty(object, key) {
        Object.defineProperty(object, key, {
      
          configurable: false,
          enumerable: true,
      
          get: function() {
            if (!this._store) {
              return null;
            }
            return this._store[key];
          },
      
          set: function(value) {
            ("production" !== "development" ? warning(
              false,
              'Don\'t set the ' + key + ' property of the component. ' +
              'Mutate the existing props object instead.'
            ) : null);
            this._store[key] = value;
          }
      
        });
      }
      
      /**
       * This is updated to true if the membrane is successfully created.
       */
      var useMutationMembrane = false;
      
      /**
       * Warn for mutations.
       *
       * @internal
       * @param {object} descriptor
       */
      function defineMutationMembrane(prototype) {
        try {
          var pseudoFrozenProperties = {
            props: true
          };
          for (var key in pseudoFrozenProperties) {
            defineWarningProperty(prototype, key);
          }
          useMutationMembrane = true;
        } catch (x) {
          // IE will fail on defineProperty
        }
      }
      
      /**
       * Transfer static properties from the source to the target. Functions are
       * rebound to have this reflect the original source.
       */
      function proxyStaticMethods(target, source) {
        if (typeof source !== 'function') {
          return;
        }
        for (var key in source) {
          if (source.hasOwnProperty(key)) {
            var value = source[key];
            if (typeof value === 'function') {
              var bound = value.bind(source);
              // Copy any properties defined on the function, such as `isRequired` on
              // a PropTypes validator. (mergeInto refuses to work on functions.)
              for (var k in value) {
                if (value.hasOwnProperty(k)) {
                  bound[k] = value[k];
                }
              }
              target[key] = bound;
            } else {
              target[key] = value;
            }
          }
        }
      }
      
      /**
       * Base constructor for all React descriptors. This is only used to make this
       * work with a dynamic instanceof check. Nothing should live on this prototype.
       *
       * @param {*} type
       * @internal
       */
      var ReactDescriptor = function() {};
      
      if ("production" !== "development") {
        defineMutationMembrane(ReactDescriptor.prototype);
      }
      
      ReactDescriptor.createFactory = function(type) {
      
        var descriptorPrototype = Object.create(ReactDescriptor.prototype);
      
        var factory = function(props, children) {
          // For consistency we currently allocate a new object for every descriptor.
          // This protects the descriptor from being mutated by the original props
          // object being mutated. It also protects the original props object from
          // being mutated by children arguments and default props. This behavior
          // comes with a performance cost and could be deprecated in the future.
          // It could also be optimized with a smarter JSX transform.
          if (props == null) {
            props = {};
          } else if (typeof props === 'object') {
            props = merge(props);
          }
      
          // Children can be more than one argument, and those are transferred onto
          // the newly allocated props object.
          var childrenLength = arguments.length - 1;
          if (childrenLength === 1) {
            props.children = children;
          } else if (childrenLength > 1) {
            var childArray = Array(childrenLength);
            for (var i = 0; i < childrenLength; i++) {
              childArray[i] = arguments[i + 1];
            }
            props.children = childArray;
          }
      
          // Initialize the descriptor object
          var descriptor = Object.create(descriptorPrototype);
      
          // Record the component responsible for creating this descriptor.
          descriptor._owner = ReactCurrentOwner.current;
      
          // TODO: Deprecate withContext, and then the context becomes accessible
          // through the owner.
          descriptor._context = ReactContext.current;
      
          if ("production" !== "development") {
            // The validation flag and props are currently mutative. We put them on
            // an external backing store so that we can freeze the whole object.
            // This can be replaced with a WeakMap once they are implemented in
            // commonly used development environments.
            descriptor._store = { validated: false, props: props };
      
            // We're not allowed to set props directly on the object so we early
            // return and rely on the prototype membrane to forward to the backing
            // store.
            if (useMutationMembrane) {
              Object.freeze(descriptor);
              return descriptor;
            }
          }
      
          descriptor.props = props;
          return descriptor;
        };
      
        // Currently we expose the prototype of the descriptor so that
        // <Foo /> instanceof Foo works. This is controversial pattern.
        factory.prototype = descriptorPrototype;
      
        // Expose the type on the factory and the prototype so that it can be
        // easily accessed on descriptors. E.g. <Foo />.type === Foo.type and for
        // static methods like <Foo />.type.staticMethod();
        // This should not be named constructor since this may not be the function
        // that created the descriptor, and it may not even be a constructor.
        factory.type = type;
        descriptorPrototype.type = type;
      
        proxyStaticMethods(factory, type);
      
        // Expose a unique constructor on the prototype is that this works with type
        // systems that compare constructor properties: <Foo />.constructor === Foo
        // This may be controversial since it requires a known factory function.
        descriptorPrototype.constructor = factory;
      
        return factory;
      
      };
      
      ReactDescriptor.cloneAndReplaceProps = function(oldDescriptor, newProps) {
        var newDescriptor = Object.create(oldDescriptor.constructor.prototype);
        // It's important that this property order matches the hidden class of the
        // original descriptor to maintain perf.
        newDescriptor._owner = oldDescriptor._owner;
        newDescriptor._context = oldDescriptor._context;
      
        if ("production" !== "development") {
          newDescriptor._store = {
            validated: oldDescriptor._store.validated,
            props: newProps
          };
          if (useMutationMembrane) {
            Object.freeze(newDescriptor);
            return newDescriptor;
          }
        }
      
        newDescriptor.props = newProps;
        return newDescriptor;
      };
      
      /**
       * Checks if a value is a valid descriptor constructor.
       *
       * @param {*}
       * @return {boolean}
       * @public
       */
      ReactDescriptor.isValidFactory = function(factory) {
        return typeof factory === 'function' &&
               factory.prototype instanceof ReactDescriptor;
      };
      
      /**
       * @param {?object} object
       * @return {boolean} True if `object` is a valid component.
       * @final
       */
      ReactDescriptor.isValidDescriptor = function(object) {
        return object instanceof ReactDescriptor;
      };
      
      module.exports = ReactDescriptor;
      
      },{"./ReactContext":34,"./ReactCurrentOwner":35,"./merge":130,"./warning":143}],52:[function(_dereq_,module,exports){
      /**
       * Copyright 2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactDescriptorValidator
       */
      
      /**
       * ReactDescriptorValidator provides a wrapper around a descriptor factory
       * which validates the props passed to the descriptor. This is intended to be
       * used only in DEV and could be replaced by a static type checker for languages
       * that support it.
       */
      
      "use strict";
      
      var ReactDescriptor = _dereq_("./ReactDescriptor");
      var ReactPropTypeLocations = _dereq_("./ReactPropTypeLocations");
      var ReactCurrentOwner = _dereq_("./ReactCurrentOwner");
      
      var monitorCodeUse = _dereq_("./monitorCodeUse");
      
      /**
       * Warn if there's no key explicitly set on dynamic arrays of children or
       * object keys are not valid. This allows us to keep track of children between
       * updates.
       */
      var ownerHasKeyUseWarning = {
        'react_key_warning': {},
        'react_numeric_key_warning': {}
      };
      var ownerHasMonitoredObjectMap = {};
      
      var loggedTypeFailures = {};
      
      var NUMERIC_PROPERTY_REGEX = /^\d+$/;
      
      /**
       * Gets the current owner's displayName for use in warnings.
       *
       * @internal
       * @return {?string} Display name or undefined
       */
      function getCurrentOwnerDisplayName() {
        var current = ReactCurrentOwner.current;
        return current && current.constructor.displayName || undefined;
      }
      
      /**
       * Warn if the component doesn't have an explicit key assigned to it.
       * This component is in an array. The array could grow and shrink or be
       * reordered. All children that haven't already been validated are required to
       * have a "key" property assigned to it.
       *
       * @internal
       * @param {ReactComponent} component Component that requires a key.
       * @param {*} parentType component's parent's type.
       */
      function validateExplicitKey(component, parentType) {
        if (component._store.validated || component.props.key != null) {
          return;
        }
        component._store.validated = true;
      
        warnAndMonitorForKeyUse(
          'react_key_warning',
          'Each child in an array should have a unique "key" prop.',
          component,
          parentType
        );
      }
      
      /**
       * Warn if the key is being defined as an object property but has an incorrect
       * value.
       *
       * @internal
       * @param {string} name Property name of the key.
       * @param {ReactComponent} component Component that requires a key.
       * @param {*} parentType component's parent's type.
       */
      function validatePropertyKey(name, component, parentType) {
        if (!NUMERIC_PROPERTY_REGEX.test(name)) {
          return;
        }
        warnAndMonitorForKeyUse(
          'react_numeric_key_warning',
          'Child objects should have non-numeric keys so ordering is preserved.',
          component,
          parentType
        );
      }
      
      /**
       * Shared warning and monitoring code for the key warnings.
       *
       * @internal
       * @param {string} warningID The id used when logging.
       * @param {string} message The base warning that gets output.
       * @param {ReactComponent} component Component that requires a key.
       * @param {*} parentType component's parent's type.
       */
      function warnAndMonitorForKeyUse(warningID, message, component, parentType) {
        var ownerName = getCurrentOwnerDisplayName();
        var parentName = parentType.displayName;
      
        var useName = ownerName || parentName;
        var memoizer = ownerHasKeyUseWarning[warningID];
        if (memoizer.hasOwnProperty(useName)) {
          return;
        }
        memoizer[useName] = true;
      
        message += ownerName ?
          (" Check the render method of " + ownerName + ".") :
          (" Check the renderComponent call using <" + parentName + ">.");
      
        // Usually the current owner is the offender, but if it accepts children as a
        // property, it may be the creator of the child that's responsible for
        // assigning it a key.
        var childOwnerName = null;
        if (component._owner && component._owner !== ReactCurrentOwner.current) {
          // Name of the component that originally created this child.
          childOwnerName = component._owner.constructor.displayName;
      
          message += (" It was passed a child from " + childOwnerName + ".");
        }
      
        message += ' See http://fb.me/react-warning-keys for more information.';
        monitorCodeUse(warningID, {
          component: useName,
          componentOwner: childOwnerName
        });
        console.warn(message);
      }
      
      /**
       * Log that we're using an object map. We're considering deprecating this
       * feature and replace it with proper Map and ImmutableMap data structures.
       *
       * @internal
       */
      function monitorUseOfObjectMap() {
        var currentName = getCurrentOwnerDisplayName() || '';
        if (ownerHasMonitoredObjectMap.hasOwnProperty(currentName)) {
          return;
        }
        ownerHasMonitoredObjectMap[currentName] = true;
        monitorCodeUse('react_object_map_children');
      }
      
      /**
       * Ensure that every component either is passed in a static location, in an
       * array with an explicit keys property defined, or in an object literal
       * with valid key property.
       *
       * @internal
       * @param {*} component Statically passed child of any type.
       * @param {*} parentType component's parent's type.
       * @return {boolean}
       */
      function validateChildKeys(component, parentType) {
        if (Array.isArray(component)) {
          for (var i = 0; i < component.length; i++) {
            var child = component[i];
            if (ReactDescriptor.isValidDescriptor(child)) {
              validateExplicitKey(child, parentType);
            }
          }
        } else if (ReactDescriptor.isValidDescriptor(component)) {
          // This component was passed in a valid location.
          component._store.validated = true;
        } else if (component && typeof component === 'object') {
          monitorUseOfObjectMap();
          for (var name in component) {
            validatePropertyKey(name, component[name], parentType);
          }
        }
      }
      
      /**
       * Assert that the props are valid
       *
       * @param {string} componentName Name of the component for error messages.
       * @param {object} propTypes Map of prop name to a ReactPropType
       * @param {object} props
       * @param {string} location e.g. "prop", "context", "child context"
       * @private
       */
      function checkPropTypes(componentName, propTypes, props, location) {
        for (var propName in propTypes) {
          if (propTypes.hasOwnProperty(propName)) {
            var error;
            // Prop type validation may throw. In case they do, we don't want to
            // fail the render phase where it didn't fail before. So we log it.
            // After these have been cleaned up, we'll let them throw.
            try {
              error = propTypes[propName](props, propName, componentName, location);
            } catch (ex) {
              error = ex;
            }
            if (error instanceof Error && !(error.message in loggedTypeFailures)) {
              // Only monitor this failure once because there tends to be a lot of the
              // same error.
              loggedTypeFailures[error.message] = true;
              // This will soon use the warning module
              monitorCodeUse(
                'react_failed_descriptor_type_check',
                { message: error.message }
              );
            }
          }
        }
      }
      
      var ReactDescriptorValidator = {
      
        /**
         * Wraps a descriptor factory function in another function which validates
         * the props and context of the descriptor and warns about any failed type
         * checks.
         *
         * @param {function} factory The original descriptor factory
         * @param {object?} propTypes A prop type definition set
         * @param {object?} contextTypes A context type definition set
         * @return {object} The component descriptor, which may be invalid.
         * @private
         */
        createFactory: function(factory, propTypes, contextTypes) {
          var validatedFactory = function(props, children) {
            var descriptor = factory.apply(this, arguments);
      
            for (var i = 1; i < arguments.length; i++) {
              validateChildKeys(arguments[i], descriptor.type);
            }
      
            var name = descriptor.type.displayName;
            if (propTypes) {
              checkPropTypes(
                name,
                propTypes,
                descriptor.props,
                ReactPropTypeLocations.prop
              );
            }
            if (contextTypes) {
              checkPropTypes(
                name,
                contextTypes,
                descriptor._context,
                ReactPropTypeLocations.context
              );
            }
            return descriptor;
          };
      
          validatedFactory.prototype = factory.prototype;
          validatedFactory.type = factory.type;
      
          // Copy static properties
          for (var key in factory) {
            if (factory.hasOwnProperty(key)) {
              validatedFactory[key] = factory[key];
            }
          }
      
          return validatedFactory;
        }
      
      };
      
      module.exports = ReactDescriptorValidator;
      
      },{"./ReactCurrentOwner":35,"./ReactDescriptor":51,"./ReactPropTypeLocations":68,"./monitorCodeUse":134}],53:[function(_dereq_,module,exports){
      /**
       * Copyright 2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactEmptyComponent
       */
      
      "use strict";
      
      var invariant = _dereq_("./invariant");
      
      var component;
      // This registry keeps track of the React IDs of the components that rendered to
      // `null` (in reality a placeholder such as `noscript`)
      var nullComponentIdsRegistry = {};
      
      var ReactEmptyComponentInjection = {
        injectEmptyComponent: function(emptyComponent) {
          component = emptyComponent;
        }
      };
      
      /**
       * @return {ReactComponent} component The injected empty component.
       */
      function getEmptyComponent() {
        ("production" !== "development" ? invariant(
          component,
          'Trying to return null from a render, but no null placeholder component ' +
          'was injected.'
        ) : invariant(component));
        return component();
      }
      
      /**
       * Mark the component as having rendered to null.
       * @param {string} id Component's `_rootNodeID`.
       */
      function registerNullComponentID(id) {
        nullComponentIdsRegistry[id] = true;
      }
      
      /**
       * Unmark the component as having rendered to null: it renders to something now.
       * @param {string} id Component's `_rootNodeID`.
       */
      function deregisterNullComponentID(id) {
        delete nullComponentIdsRegistry[id];
      }
      
      /**
       * @param {string} id Component's `_rootNodeID`.
       * @return {boolean} True if the component is rendered to null.
       */
      function isNullComponentID(id) {
        return nullComponentIdsRegistry[id];
      }
      
      var ReactEmptyComponent = {
        deregisterNullComponentID: deregisterNullComponentID,
        getEmptyComponent: getEmptyComponent,
        injection: ReactEmptyComponentInjection,
        isNullComponentID: isNullComponentID,
        registerNullComponentID: registerNullComponentID
      };
      
      module.exports = ReactEmptyComponent;
      
      },{"./invariant":120}],54:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactErrorUtils
       * @typechecks
       */
      
      "use strict";
      
      var ReactErrorUtils = {
        /**
         * Creates a guarded version of a function. This is supposed to make debugging
         * of event handlers easier. To aid debugging with the browser's debugger,
         * this currently simply returns the original function.
         *
         * @param {function} func Function to be executed
         * @param {string} name The name of the guard
         * @return {function}
         */
        guard: function(func, name) {
          return func;
        }
      };
      
      module.exports = ReactErrorUtils;
      
      },{}],55:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactEventEmitterMixin
       */
      
      "use strict";
      
      var EventPluginHub = _dereq_("./EventPluginHub");
      
      function runEventQueueInBatch(events) {
        EventPluginHub.enqueueEvents(events);
        EventPluginHub.processEventQueue();
      }
      
      var ReactEventEmitterMixin = {
      
        /**
         * Streams a fired top-level event to `EventPluginHub` where plugins have the
         * opportunity to create `ReactEvent`s to be dispatched.
         *
         * @param {string} topLevelType Record from `EventConstants`.
         * @param {object} topLevelTarget The listening component root node.
         * @param {string} topLevelTargetID ID of `topLevelTarget`.
         * @param {object} nativeEvent Native environment event.
         */
        handleTopLevel: function(
            topLevelType,
            topLevelTarget,
            topLevelTargetID,
            nativeEvent) {
          var events = EventPluginHub.extractEvents(
            topLevelType,
            topLevelTarget,
            topLevelTargetID,
            nativeEvent
          );
      
          runEventQueueInBatch(events);
        }
      };
      
      module.exports = ReactEventEmitterMixin;
      
      },{"./EventPluginHub":17}],56:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactEventListener
       * @typechecks static-only
       */
      
      "use strict";
      
      var EventListener = _dereq_("./EventListener");
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      var PooledClass = _dereq_("./PooledClass");
      var ReactInstanceHandles = _dereq_("./ReactInstanceHandles");
      var ReactMount = _dereq_("./ReactMount");
      var ReactUpdates = _dereq_("./ReactUpdates");
      
      var getEventTarget = _dereq_("./getEventTarget");
      var getUnboundedScrollPosition = _dereq_("./getUnboundedScrollPosition");
      var mixInto = _dereq_("./mixInto");
      
      /**
       * Finds the parent React component of `node`.
       *
       * @param {*} node
       * @return {?DOMEventTarget} Parent container, or `null` if the specified node
       *                           is not nested.
       */
      function findParent(node) {
        // TODO: It may be a good idea to cache this to prevent unnecessary DOM
        // traversal, but caching is difficult to do correctly without using a
        // mutation observer to listen for all DOM changes.
        var nodeID = ReactMount.getID(node);
        var rootID = ReactInstanceHandles.getReactRootIDFromNodeID(nodeID);
        var container = ReactMount.findReactContainerForID(rootID);
        var parent = ReactMount.getFirstReactDOM(container);
        return parent;
      }
      
      // Used to store ancestor hierarchy in top level callback
      function TopLevelCallbackBookKeeping(topLevelType, nativeEvent) {
        this.topLevelType = topLevelType;
        this.nativeEvent = nativeEvent;
        this.ancestors = [];
      }
      mixInto(TopLevelCallbackBookKeeping, {
        destructor: function() {
          this.topLevelType = null;
          this.nativeEvent = null;
          this.ancestors.length = 0;
        }
      });
      PooledClass.addPoolingTo(
        TopLevelCallbackBookKeeping,
        PooledClass.twoArgumentPooler
      );
      
      function handleTopLevelImpl(bookKeeping) {
        var topLevelTarget = ReactMount.getFirstReactDOM(
          getEventTarget(bookKeeping.nativeEvent)
        ) || window;
      
        // Loop through the hierarchy, in case there's any nested components.
        // It's important that we build the array of ancestors before calling any
        // event handlers, because event handlers can modify the DOM, leading to
        // inconsistencies with ReactMount's node cache. See #1105.
        var ancestor = topLevelTarget;
        while (ancestor) {
          bookKeeping.ancestors.push(ancestor);
          ancestor = findParent(ancestor);
        }
      
        for (var i = 0, l = bookKeeping.ancestors.length; i < l; i++) {
          topLevelTarget = bookKeeping.ancestors[i];
          var topLevelTargetID = ReactMount.getID(topLevelTarget) || '';
          ReactEventListener._handleTopLevel(
            bookKeeping.topLevelType,
            topLevelTarget,
            topLevelTargetID,
            bookKeeping.nativeEvent
          );
        }
      }
      
      function scrollValueMonitor(cb) {
        var scrollPosition = getUnboundedScrollPosition(window);
        cb(scrollPosition);
      }
      
      var ReactEventListener = {
        _enabled: true,
        _handleTopLevel: null,
      
        WINDOW_HANDLE: ExecutionEnvironment.canUseDOM ? window : null,
      
        setHandleTopLevel: function(handleTopLevel) {
          ReactEventListener._handleTopLevel = handleTopLevel;
        },
      
        setEnabled: function(enabled) {
          ReactEventListener._enabled = !!enabled;
        },
      
        isEnabled: function() {
          return ReactEventListener._enabled;
        },
      
      
        /**
         * Traps top-level events by using event bubbling.
         *
         * @param {string} topLevelType Record from `EventConstants`.
         * @param {string} handlerBaseName Event name (e.g. "click").
         * @param {object} handle Element on which to attach listener.
         * @return {object} An object with a remove function which will forcefully
         *                  remove the listener.
         * @internal
         */
        trapBubbledEvent: function(topLevelType, handlerBaseName, handle) {
          var element = handle;
          if (!element) {
            return;
          }
          return EventListener.listen(
            element,
            handlerBaseName,
            ReactEventListener.dispatchEvent.bind(null, topLevelType)
          );
        },
      
        /**
         * Traps a top-level event by using event capturing.
         *
         * @param {string} topLevelType Record from `EventConstants`.
         * @param {string} handlerBaseName Event name (e.g. "click").
         * @param {object} handle Element on which to attach listener.
         * @return {object} An object with a remove function which will forcefully
         *                  remove the listener.
         * @internal
         */
        trapCapturedEvent: function(topLevelType, handlerBaseName, handle) {
          var element = handle;
          if (!element) {
            return;
          }
          return EventListener.capture(
            element,
            handlerBaseName,
            ReactEventListener.dispatchEvent.bind(null, topLevelType)
          );
        },
      
        monitorScrollValue: function(refresh) {
          var callback = scrollValueMonitor.bind(null, refresh);
          EventListener.listen(window, 'scroll', callback);
          EventListener.listen(window, 'resize', callback);
        },
      
        dispatchEvent: function(topLevelType, nativeEvent) {
          if (!ReactEventListener._enabled) {
            return;
          }
      
          var bookKeeping = TopLevelCallbackBookKeeping.getPooled(
            topLevelType,
            nativeEvent
          );
          try {
            // Event queue being processed in the same cycle allows
            // `preventDefault`.
            ReactUpdates.batchedUpdates(handleTopLevelImpl, bookKeeping);
          } finally {
            TopLevelCallbackBookKeeping.release(bookKeeping);
          }
        }
      };
      
      module.exports = ReactEventListener;
      
      },{"./EventListener":16,"./ExecutionEnvironment":21,"./PooledClass":26,"./ReactInstanceHandles":59,"./ReactMount":61,"./ReactUpdates":76,"./getEventTarget":111,"./getUnboundedScrollPosition":116,"./mixInto":133}],57:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactInjection
       */
      
      "use strict";
      
      var DOMProperty = _dereq_("./DOMProperty");
      var EventPluginHub = _dereq_("./EventPluginHub");
      var ReactComponent = _dereq_("./ReactComponent");
      var ReactCompositeComponent = _dereq_("./ReactCompositeComponent");
      var ReactDOM = _dereq_("./ReactDOM");
      var ReactEmptyComponent = _dereq_("./ReactEmptyComponent");
      var ReactBrowserEventEmitter = _dereq_("./ReactBrowserEventEmitter");
      var ReactPerf = _dereq_("./ReactPerf");
      var ReactRootIndex = _dereq_("./ReactRootIndex");
      var ReactUpdates = _dereq_("./ReactUpdates");
      
      var ReactInjection = {
        Component: ReactComponent.injection,
        CompositeComponent: ReactCompositeComponent.injection,
        DOMProperty: DOMProperty.injection,
        EmptyComponent: ReactEmptyComponent.injection,
        EventPluginHub: EventPluginHub.injection,
        DOM: ReactDOM.injection,
        EventEmitter: ReactBrowserEventEmitter.injection,
        Perf: ReactPerf.injection,
        RootIndex: ReactRootIndex.injection,
        Updates: ReactUpdates.injection
      };
      
      module.exports = ReactInjection;
      
      },{"./DOMProperty":10,"./EventPluginHub":17,"./ReactBrowserEventEmitter":29,"./ReactComponent":31,"./ReactCompositeComponent":33,"./ReactDOM":36,"./ReactEmptyComponent":53,"./ReactPerf":65,"./ReactRootIndex":72,"./ReactUpdates":76}],58:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactInputSelection
       */
      
      "use strict";
      
      var ReactDOMSelection = _dereq_("./ReactDOMSelection");
      
      var containsNode = _dereq_("./containsNode");
      var focusNode = _dereq_("./focusNode");
      var getActiveElement = _dereq_("./getActiveElement");
      
      function isInDocument(node) {
        return containsNode(document.documentElement, node);
      }
      
      /**
       * @ReactInputSelection: React input selection module. Based on Selection.js,
       * but modified to be suitable for react and has a couple of bug fixes (doesn't
       * assume buttons have range selections allowed).
       * Input selection module for React.
       */
      var ReactInputSelection = {
      
        hasSelectionCapabilities: function(elem) {
          return elem && (
            (elem.nodeName === 'INPUT' && elem.type === 'text') ||
            elem.nodeName === 'TEXTAREA' ||
            elem.contentEditable === 'true'
          );
        },
      
        getSelectionInformation: function() {
          var focusedElem = getActiveElement();
          return {
            focusedElem: focusedElem,
            selectionRange:
                ReactInputSelection.hasSelectionCapabilities(focusedElem) ?
                ReactInputSelection.getSelection(focusedElem) :
                null
          };
        },
      
        /**
         * @restoreSelection: If any selection information was potentially lost,
         * restore it. This is useful when performing operations that could remove dom
         * nodes and place them back in, resulting in focus being lost.
         */
        restoreSelection: function(priorSelectionInformation) {
          var curFocusedElem = getActiveElement();
          var priorFocusedElem = priorSelectionInformation.focusedElem;
          var priorSelectionRange = priorSelectionInformation.selectionRange;
          if (curFocusedElem !== priorFocusedElem &&
              isInDocument(priorFocusedElem)) {
            if (ReactInputSelection.hasSelectionCapabilities(priorFocusedElem)) {
              ReactInputSelection.setSelection(
                priorFocusedElem,
                priorSelectionRange
              );
            }
            focusNode(priorFocusedElem);
          }
        },
      
        /**
         * @getSelection: Gets the selection bounds of a focused textarea, input or
         * contentEditable node.
         * -@input: Look up selection bounds of this input
         * -@return {start: selectionStart, end: selectionEnd}
         */
        getSelection: function(input) {
          var selection;
      
          if ('selectionStart' in input) {
            // Modern browser with input or textarea.
            selection = {
              start: input.selectionStart,
              end: input.selectionEnd
            };
          } else if (document.selection && input.nodeName === 'INPUT') {
            // IE8 input.
            var range = document.selection.createRange();
            // There can only be one selection per document in IE, so it must
            // be in our element.
            if (range.parentElement() === input) {
              selection = {
                start: -range.moveStart('character', -input.value.length),
                end: -range.moveEnd('character', -input.value.length)
              };
            }
          } else {
            // Content editable or old IE textarea.
            selection = ReactDOMSelection.getOffsets(input);
          }
      
          return selection || {start: 0, end: 0};
        },
      
        /**
         * @setSelection: Sets the selection bounds of a textarea or input and focuses
         * the input.
         * -@input     Set selection bounds of this input or textarea
         * -@offsets   Object of same form that is returned from get*
         */
        setSelection: function(input, offsets) {
          var start = offsets.start;
          var end = offsets.end;
          if (typeof end === 'undefined') {
            end = start;
          }
      
          if ('selectionStart' in input) {
            input.selectionStart = start;
            input.selectionEnd = Math.min(end, input.value.length);
          } else if (document.selection && input.nodeName === 'INPUT') {
            var range = input.createTextRange();
            range.collapse(true);
            range.moveStart('character', start);
            range.moveEnd('character', end - start);
            range.select();
          } else {
            ReactDOMSelection.setOffsets(input, offsets);
          }
        }
      };
      
      module.exports = ReactInputSelection;
      
      },{"./ReactDOMSelection":45,"./containsNode":96,"./focusNode":106,"./getActiveElement":108}],59:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactInstanceHandles
       * @typechecks static-only
       */
      
      "use strict";
      
      var ReactRootIndex = _dereq_("./ReactRootIndex");
      
      var invariant = _dereq_("./invariant");
      
      var SEPARATOR = '.';
      var SEPARATOR_LENGTH = SEPARATOR.length;
      
      /**
       * Maximum depth of traversals before we consider the possibility of a bad ID.
       */
      var MAX_TREE_DEPTH = 100;
      
      /**
       * Creates a DOM ID prefix to use when mounting React components.
       *
       * @param {number} index A unique integer
       * @return {string} React root ID.
       * @internal
       */
      function getReactRootIDString(index) {
        return SEPARATOR + index.toString(36);
      }
      
      /**
       * Checks if a character in the supplied ID is a separator or the end.
       *
       * @param {string} id A React DOM ID.
       * @param {number} index Index of the character to check.
       * @return {boolean} True if the character is a separator or end of the ID.
       * @private
       */
      function isBoundary(id, index) {
        return id.charAt(index) === SEPARATOR || index === id.length;
      }
      
      /**
       * Checks if the supplied string is a valid React DOM ID.
       *
       * @param {string} id A React DOM ID, maybe.
       * @return {boolean} True if the string is a valid React DOM ID.
       * @private
       */
      function isValidID(id) {
        return id === '' || (
          id.charAt(0) === SEPARATOR && id.charAt(id.length - 1) !== SEPARATOR
        );
      }
      
      /**
       * Checks if the first ID is an ancestor of or equal to the second ID.
       *
       * @param {string} ancestorID
       * @param {string} descendantID
       * @return {boolean} True if `ancestorID` is an ancestor of `descendantID`.
       * @internal
       */
      function isAncestorIDOf(ancestorID, descendantID) {
        return (
          descendantID.indexOf(ancestorID) === 0 &&
          isBoundary(descendantID, ancestorID.length)
        );
      }
      
      /**
       * Gets the parent ID of the supplied React DOM ID, `id`.
       *
       * @param {string} id ID of a component.
       * @return {string} ID of the parent, or an empty string.
       * @private
       */
      function getParentID(id) {
        return id ? id.substr(0, id.lastIndexOf(SEPARATOR)) : '';
      }
      
      /**
       * Gets the next DOM ID on the tree path from the supplied `ancestorID` to the
       * supplied `destinationID`. If they are equal, the ID is returned.
       *
       * @param {string} ancestorID ID of an ancestor node of `destinationID`.
       * @param {string} destinationID ID of the destination node.
       * @return {string} Next ID on the path from `ancestorID` to `destinationID`.
       * @private
       */
      function getNextDescendantID(ancestorID, destinationID) {
        ("production" !== "development" ? invariant(
          isValidID(ancestorID) && isValidID(destinationID),
          'getNextDescendantID(%s, %s): Received an invalid React DOM ID.',
          ancestorID,
          destinationID
        ) : invariant(isValidID(ancestorID) && isValidID(destinationID)));
        ("production" !== "development" ? invariant(
          isAncestorIDOf(ancestorID, destinationID),
          'getNextDescendantID(...): React has made an invalid assumption about ' +
          'the DOM hierarchy. Expected `%s` to be an ancestor of `%s`.',
          ancestorID,
          destinationID
        ) : invariant(isAncestorIDOf(ancestorID, destinationID)));
        if (ancestorID === destinationID) {
          return ancestorID;
        }
        // Skip over the ancestor and the immediate separator. Traverse until we hit
        // another separator or we reach the end of `destinationID`.
        var start = ancestorID.length + SEPARATOR_LENGTH;
        for (var i = start; i < destinationID.length; i++) {
          if (isBoundary(destinationID, i)) {
            break;
          }
        }
        return destinationID.substr(0, i);
      }
      
      /**
       * Gets the nearest common ancestor ID of two IDs.
       *
       * Using this ID scheme, the nearest common ancestor ID is the longest common
       * prefix of the two IDs that immediately preceded a "marker" in both strings.
       *
       * @param {string} oneID
       * @param {string} twoID
       * @return {string} Nearest common ancestor ID, or the empty string if none.
       * @private
       */
      function getFirstCommonAncestorID(oneID, twoID) {
        var minLength = Math.min(oneID.length, twoID.length);
        if (minLength === 0) {
          return '';
        }
        var lastCommonMarkerIndex = 0;
        // Use `<=` to traverse until the "EOL" of the shorter string.
        for (var i = 0; i <= minLength; i++) {
          if (isBoundary(oneID, i) && isBoundary(twoID, i)) {
            lastCommonMarkerIndex = i;
          } else if (oneID.charAt(i) !== twoID.charAt(i)) {
            break;
          }
        }
        var longestCommonID = oneID.substr(0, lastCommonMarkerIndex);
        ("production" !== "development" ? invariant(
          isValidID(longestCommonID),
          'getFirstCommonAncestorID(%s, %s): Expected a valid React DOM ID: %s',
          oneID,
          twoID,
          longestCommonID
        ) : invariant(isValidID(longestCommonID)));
        return longestCommonID;
      }
      
      /**
       * Traverses the parent path between two IDs (either up or down). The IDs must
       * not be the same, and there must exist a parent path between them. If the
       * callback returns `false`, traversal is stopped.
       *
       * @param {?string} start ID at which to start traversal.
       * @param {?string} stop ID at which to end traversal.
       * @param {function} cb Callback to invoke each ID with.
       * @param {?boolean} skipFirst Whether or not to skip the first node.
       * @param {?boolean} skipLast Whether or not to skip the last node.
       * @private
       */
      function traverseParentPath(start, stop, cb, arg, skipFirst, skipLast) {
        start = start || '';
        stop = stop || '';
        ("production" !== "development" ? invariant(
          start !== stop,
          'traverseParentPath(...): Cannot traverse from and to the same ID, `%s`.',
          start
        ) : invariant(start !== stop));
        var traverseUp = isAncestorIDOf(stop, start);
        ("production" !== "development" ? invariant(
          traverseUp || isAncestorIDOf(start, stop),
          'traverseParentPath(%s, %s, ...): Cannot traverse from two IDs that do ' +
          'not have a parent path.',
          start,
          stop
        ) : invariant(traverseUp || isAncestorIDOf(start, stop)));
        // Traverse from `start` to `stop` one depth at a time.
        var depth = 0;
        var traverse = traverseUp ? getParentID : getNextDescendantID;
        for (var id = start; /* until break */; id = traverse(id, stop)) {
          var ret;
          if ((!skipFirst || id !== start) && (!skipLast || id !== stop)) {
            ret = cb(id, traverseUp, arg);
          }
          if (ret === false || id === stop) {
            // Only break //after// visiting `stop`.
            break;
          }
          ("production" !== "development" ? invariant(
            depth++ < MAX_TREE_DEPTH,
            'traverseParentPath(%s, %s, ...): Detected an infinite loop while ' +
            'traversing the React DOM ID tree. This may be due to malformed IDs: %s',
            start, stop
          ) : invariant(depth++ < MAX_TREE_DEPTH));
        }
      }
      
      /**
       * Manages the IDs assigned to DOM representations of React components. This
       * uses a specific scheme in order to traverse the DOM efficiently (e.g. in
       * order to simulate events).
       *
       * @internal
       */
      var ReactInstanceHandles = {
      
        /**
         * Constructs a React root ID
         * @return {string} A React root ID.
         */
        createReactRootID: function() {
          return getReactRootIDString(ReactRootIndex.createReactRootIndex());
        },
      
        /**
         * Constructs a React ID by joining a root ID with a name.
         *
         * @param {string} rootID Root ID of a parent component.
         * @param {string} name A component's name (as flattened children).
         * @return {string} A React ID.
         * @internal
         */
        createReactID: function(rootID, name) {
          return rootID + name;
        },
      
        /**
         * Gets the DOM ID of the React component that is the root of the tree that
         * contains the React component with the supplied DOM ID.
         *
         * @param {string} id DOM ID of a React component.
         * @return {?string} DOM ID of the React component that is the root.
         * @internal
         */
        getReactRootIDFromNodeID: function(id) {
          if (id && id.charAt(0) === SEPARATOR && id.length > 1) {
            var index = id.indexOf(SEPARATOR, 1);
            return index > -1 ? id.substr(0, index) : id;
          }
          return null;
        },
      
        /**
         * Traverses the ID hierarchy and invokes the supplied `cb` on any IDs that
         * should would receive a `mouseEnter` or `mouseLeave` event.
         *
         * NOTE: Does not invoke the callback on the nearest common ancestor because
         * nothing "entered" or "left" that element.
         *
         * @param {string} leaveID ID being left.
         * @param {string} enterID ID being entered.
         * @param {function} cb Callback to invoke on each entered/left ID.
         * @param {*} upArg Argument to invoke the callback with on left IDs.
         * @param {*} downArg Argument to invoke the callback with on entered IDs.
         * @internal
         */
        traverseEnterLeave: function(leaveID, enterID, cb, upArg, downArg) {
          var ancestorID = getFirstCommonAncestorID(leaveID, enterID);
          if (ancestorID !== leaveID) {
            traverseParentPath(leaveID, ancestorID, cb, upArg, false, true);
          }
          if (ancestorID !== enterID) {
            traverseParentPath(ancestorID, enterID, cb, downArg, true, false);
          }
        },
      
        /**
         * Simulates the traversal of a two-phase, capture/bubble event dispatch.
         *
         * NOTE: This traversal happens on IDs without touching the DOM.
         *
         * @param {string} targetID ID of the target node.
         * @param {function} cb Callback to invoke.
         * @param {*} arg Argument to invoke the callback with.
         * @internal
         */
        traverseTwoPhase: function(targetID, cb, arg) {
          if (targetID) {
            traverseParentPath('', targetID, cb, arg, true, false);
            traverseParentPath(targetID, '', cb, arg, false, true);
          }
        },
      
        /**
         * Traverse a node ID, calling the supplied `cb` for each ancestor ID. For
         * example, passing `.0.$row-0.1` would result in `cb` getting called
         * with `.0`, `.0.$row-0`, and `.0.$row-0.1`.
         *
         * NOTE: This traversal happens on IDs without touching the DOM.
         *
         * @param {string} targetID ID of the target node.
         * @param {function} cb Callback to invoke.
         * @param {*} arg Argument to invoke the callback with.
         * @internal
         */
        traverseAncestors: function(targetID, cb, arg) {
          traverseParentPath('', targetID, cb, arg, true, false);
        },
      
        /**
         * Exposed for unit testing.
         * @private
         */
        _getFirstCommonAncestorID: getFirstCommonAncestorID,
      
        /**
         * Exposed for unit testing.
         * @private
         */
        _getNextDescendantID: getNextDescendantID,
      
        isAncestorIDOf: isAncestorIDOf,
      
        SEPARATOR: SEPARATOR
      
      };
      
      module.exports = ReactInstanceHandles;
      
      },{"./ReactRootIndex":72,"./invariant":120}],60:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactMarkupChecksum
       */
      
      "use strict";
      
      var adler32 = _dereq_("./adler32");
      
      var ReactMarkupChecksum = {
        CHECKSUM_ATTR_NAME: 'data-react-checksum',
      
        /**
         * @param {string} markup Markup string
         * @return {string} Markup string with checksum attribute attached
         */
        addChecksumToMarkup: function(markup) {
          var checksum = adler32(markup);
          return markup.replace(
            '>',
            ' ' + ReactMarkupChecksum.CHECKSUM_ATTR_NAME + '="' + checksum + '">'
          );
        },
      
        /**
         * @param {string} markup to use
         * @param {DOMElement} element root React element
         * @returns {boolean} whether or not the markup is the same
         */
        canReuseMarkup: function(markup, element) {
          var existingChecksum = element.getAttribute(
            ReactMarkupChecksum.CHECKSUM_ATTR_NAME
          );
          existingChecksum = existingChecksum && parseInt(existingChecksum, 10);
          var markupChecksum = adler32(markup);
          return markupChecksum === existingChecksum;
        }
      };
      
      module.exports = ReactMarkupChecksum;
      
      },{"./adler32":95}],61:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactMount
       */
      
      "use strict";
      
      var DOMProperty = _dereq_("./DOMProperty");
      var ReactBrowserEventEmitter = _dereq_("./ReactBrowserEventEmitter");
      var ReactCurrentOwner = _dereq_("./ReactCurrentOwner");
      var ReactDescriptor = _dereq_("./ReactDescriptor");
      var ReactInstanceHandles = _dereq_("./ReactInstanceHandles");
      var ReactPerf = _dereq_("./ReactPerf");
      
      var containsNode = _dereq_("./containsNode");
      var getReactRootElementInContainer = _dereq_("./getReactRootElementInContainer");
      var instantiateReactComponent = _dereq_("./instantiateReactComponent");
      var invariant = _dereq_("./invariant");
      var shouldUpdateReactComponent = _dereq_("./shouldUpdateReactComponent");
      var warning = _dereq_("./warning");
      
      var SEPARATOR = ReactInstanceHandles.SEPARATOR;
      
      var ATTR_NAME = DOMProperty.ID_ATTRIBUTE_NAME;
      var nodeCache = {};
      
      var ELEMENT_NODE_TYPE = 1;
      var DOC_NODE_TYPE = 9;
      
      /** Mapping from reactRootID to React component instance. */
      var instancesByReactRootID = {};
      
      /** Mapping from reactRootID to `container` nodes. */
      var containersByReactRootID = {};
      
      if ("production" !== "development") {
        /** __DEV__-only mapping from reactRootID to root elements. */
        var rootElementsByReactRootID = {};
      }
      
      // Used to store breadth-first search state in findComponentRoot.
      var findComponentRootReusableArray = [];
      
      /**
       * @param {DOMElement} container DOM element that may contain a React component.
       * @return {?string} A "reactRoot" ID, if a React component is rendered.
       */
      function getReactRootID(container) {
        var rootElement = getReactRootElementInContainer(container);
        return rootElement && ReactMount.getID(rootElement);
      }
      
      /**
       * Accessing node[ATTR_NAME] or calling getAttribute(ATTR_NAME) on a form
       * element can return its control whose name or ID equals ATTR_NAME. All
       * DOM nodes support `getAttributeNode` but this can also get called on
       * other objects so just return '' if we're given something other than a
       * DOM node (such as window).
       *
       * @param {?DOMElement|DOMWindow|DOMDocument|DOMTextNode} node DOM node.
       * @return {string} ID of the supplied `domNode`.
       */
      function getID(node) {
        var id = internalGetID(node);
        if (id) {
          if (nodeCache.hasOwnProperty(id)) {
            var cached = nodeCache[id];
            if (cached !== node) {
              ("production" !== "development" ? invariant(
                !isValid(cached, id),
                'ReactMount: Two valid but unequal nodes with the same `%s`: %s',
                ATTR_NAME, id
              ) : invariant(!isValid(cached, id)));
      
              nodeCache[id] = node;
            }
          } else {
            nodeCache[id] = node;
          }
        }
      
        return id;
      }
      
      function internalGetID(node) {
        // If node is something like a window, document, or text node, none of
        // which support attributes or a .getAttribute method, gracefully return
        // the empty string, as if the attribute were missing.
        return node && node.getAttribute && node.getAttribute(ATTR_NAME) || '';
      }
      
      /**
       * Sets the React-specific ID of the given node.
       *
       * @param {DOMElement} node The DOM node whose ID will be set.
       * @param {string} id The value of the ID attribute.
       */
      function setID(node, id) {
        var oldID = internalGetID(node);
        if (oldID !== id) {
          delete nodeCache[oldID];
        }
        node.setAttribute(ATTR_NAME, id);
        nodeCache[id] = node;
      }
      
      /**
       * Finds the node with the supplied React-generated DOM ID.
       *
       * @param {string} id A React-generated DOM ID.
       * @return {DOMElement} DOM node with the suppled `id`.
       * @internal
       */
      function getNode(id) {
        if (!nodeCache.hasOwnProperty(id) || !isValid(nodeCache[id], id)) {
          nodeCache[id] = ReactMount.findReactNodeByID(id);
        }
        return nodeCache[id];
      }
      
      /**
       * A node is "valid" if it is contained by a currently mounted container.
       *
       * This means that the node does not have to be contained by a document in
       * order to be considered valid.
       *
       * @param {?DOMElement} node The candidate DOM node.
       * @param {string} id The expected ID of the node.
       * @return {boolean} Whether the node is contained by a mounted container.
       */
      function isValid(node, id) {
        if (node) {
          ("production" !== "development" ? invariant(
            internalGetID(node) === id,
            'ReactMount: Unexpected modification of `%s`',
            ATTR_NAME
          ) : invariant(internalGetID(node) === id));
      
          var container = ReactMount.findReactContainerForID(id);
          if (container && containsNode(container, node)) {
            return true;
          }
        }
      
        return false;
      }
      
      /**
       * Causes the cache to forget about one React-specific ID.
       *
       * @param {string} id The ID to forget.
       */
      function purgeID(id) {
        delete nodeCache[id];
      }
      
      var deepestNodeSoFar = null;
      function findDeepestCachedAncestorImpl(ancestorID) {
        var ancestor = nodeCache[ancestorID];
        if (ancestor && isValid(ancestor, ancestorID)) {
          deepestNodeSoFar = ancestor;
        } else {
          // This node isn't populated in the cache, so presumably none of its
          // descendants are. Break out of the loop.
          return false;
        }
      }
      
      /**
       * Return the deepest cached node whose ID is a prefix of `targetID`.
       */
      function findDeepestCachedAncestor(targetID) {
        deepestNodeSoFar = null;
        ReactInstanceHandles.traverseAncestors(
          targetID,
          findDeepestCachedAncestorImpl
        );
      
        var foundNode = deepestNodeSoFar;
        deepestNodeSoFar = null;
        return foundNode;
      }
      
      /**
       * Mounting is the process of initializing a React component by creatings its
       * representative DOM elements and inserting them into a supplied `container`.
       * Any prior content inside `container` is destroyed in the process.
       *
       *   ReactMount.renderComponent(
       *     component,
       *     document.getElementById('container')
       *   );
       *
       *   <div id="container">                   <-- Supplied `container`.
       *     <div data-reactid=".3">              <-- Rendered reactRoot of React
       *       // ...                                 component.
       *     </div>
       *   </div>
       *
       * Inside of `container`, the first element rendered is the "reactRoot".
       */
      var ReactMount = {
        /** Exposed for debugging purposes **/
        _instancesByReactRootID: instancesByReactRootID,
      
        /**
         * This is a hook provided to support rendering React components while
         * ensuring that the apparent scroll position of its `container` does not
         * change.
         *
         * @param {DOMElement} container The `container` being rendered into.
         * @param {function} renderCallback This must be called once to do the render.
         */
        scrollMonitor: function(container, renderCallback) {
          renderCallback();
        },
      
        /**
         * Take a component that's already mounted into the DOM and replace its props
         * @param {ReactComponent} prevComponent component instance already in the DOM
         * @param {ReactComponent} nextComponent component instance to render
         * @param {DOMElement} container container to render into
         * @param {?function} callback function triggered on completion
         */
        _updateRootComponent: function(
            prevComponent,
            nextComponent,
            container,
            callback) {
          var nextProps = nextComponent.props;
          ReactMount.scrollMonitor(container, function() {
            prevComponent.replaceProps(nextProps, callback);
          });
      
          if ("production" !== "development") {
            // Record the root element in case it later gets transplanted.
            rootElementsByReactRootID[getReactRootID(container)] =
              getReactRootElementInContainer(container);
          }
      
          return prevComponent;
        },
      
        /**
         * Register a component into the instance map and starts scroll value
         * monitoring
         * @param {ReactComponent} nextComponent component instance to render
         * @param {DOMElement} container container to render into
         * @return {string} reactRoot ID prefix
         */
        _registerComponent: function(nextComponent, container) {
          ("production" !== "development" ? invariant(
            container && (
              container.nodeType === ELEMENT_NODE_TYPE ||
              container.nodeType === DOC_NODE_TYPE
            ),
            '_registerComponent(...): Target container is not a DOM element.'
          ) : invariant(container && (
            container.nodeType === ELEMENT_NODE_TYPE ||
            container.nodeType === DOC_NODE_TYPE
          )));
      
          ReactBrowserEventEmitter.ensureScrollValueMonitoring();
      
          var reactRootID = ReactMount.registerContainer(container);
          instancesByReactRootID[reactRootID] = nextComponent;
          return reactRootID;
        },
      
        /**
         * Render a new component into the DOM.
         * @param {ReactComponent} nextComponent component instance to render
         * @param {DOMElement} container container to render into
         * @param {boolean} shouldReuseMarkup if we should skip the markup insertion
         * @return {ReactComponent} nextComponent
         */
        _renderNewRootComponent: ReactPerf.measure(
          'ReactMount',
          '_renderNewRootComponent',
          function(
              nextComponent,
              container,
              shouldReuseMarkup) {
            // Various parts of our code (such as ReactCompositeComponent's
            // _renderValidatedComponent) assume that calls to render aren't nested;
            // verify that that's the case.
            ("production" !== "development" ? warning(
              ReactCurrentOwner.current == null,
              '_renderNewRootComponent(): Render methods should be a pure function ' +
              'of props and state; triggering nested component updates from ' +
              'render is not allowed. If necessary, trigger nested updates in ' +
              'componentDidUpdate.'
            ) : null);
      
            var componentInstance = instantiateReactComponent(nextComponent);
            var reactRootID = ReactMount._registerComponent(
              componentInstance,
              container
            );
            componentInstance.mountComponentIntoNode(
              reactRootID,
              container,
              shouldReuseMarkup
            );
      
            if ("production" !== "development") {
              // Record the root element in case it later gets transplanted.
              rootElementsByReactRootID[reactRootID] =
                getReactRootElementInContainer(container);
            }
      
            return componentInstance;
          }
        ),
      
        /**
         * Renders a React component into the DOM in the supplied `container`.
         *
         * If the React component was previously rendered into `container`, this will
         * perform an update on it and only mutate the DOM as necessary to reflect the
         * latest React component.
         *
         * @param {ReactDescriptor} nextDescriptor Component descriptor to render.
         * @param {DOMElement} container DOM element to render into.
         * @param {?function} callback function triggered on completion
         * @return {ReactComponent} Component instance rendered in `container`.
         */
        renderComponent: function(nextDescriptor, container, callback) {
          ("production" !== "development" ? invariant(
            ReactDescriptor.isValidDescriptor(nextDescriptor),
            'renderComponent(): Invalid component descriptor.%s',
            (
              ReactDescriptor.isValidFactory(nextDescriptor) ?
                ' Instead of passing a component class, make sure to instantiate ' +
                'it first by calling it with props.' :
              // Check if it quacks like a descriptor
              typeof nextDescriptor.props !== "undefined" ?
                ' This may be caused by unintentionally loading two independent ' +
                'copies of React.' :
                ''
            )
          ) : invariant(ReactDescriptor.isValidDescriptor(nextDescriptor)));
      
          var prevComponent = instancesByReactRootID[getReactRootID(container)];
      
          if (prevComponent) {
            var prevDescriptor = prevComponent._descriptor;
            if (shouldUpdateReactComponent(prevDescriptor, nextDescriptor)) {
              return ReactMount._updateRootComponent(
                prevComponent,
                nextDescriptor,
                container,
                callback
              );
            } else {
              ReactMount.unmountComponentAtNode(container);
            }
          }
      
          var reactRootElement = getReactRootElementInContainer(container);
          var containerHasReactMarkup =
            reactRootElement && ReactMount.isRenderedByReact(reactRootElement);
      
          var shouldReuseMarkup = containerHasReactMarkup && !prevComponent;
      
          var component = ReactMount._renderNewRootComponent(
            nextDescriptor,
            container,
            shouldReuseMarkup
          );
          callback && callback.call(component);
          return component;
        },
      
        /**
         * Constructs a component instance of `constructor` with `initialProps` and
         * renders it into the supplied `container`.
         *
         * @param {function} constructor React component constructor.
         * @param {?object} props Initial props of the component instance.
         * @param {DOMElement} container DOM element to render into.
         * @return {ReactComponent} Component instance rendered in `container`.
         */
        constructAndRenderComponent: function(constructor, props, container) {
          return ReactMount.renderComponent(constructor(props), container);
        },
      
        /**
         * Constructs a component instance of `constructor` with `initialProps` and
         * renders it into a container node identified by supplied `id`.
         *
         * @param {function} componentConstructor React component constructor
         * @param {?object} props Initial props of the component instance.
         * @param {string} id ID of the DOM element to render into.
         * @return {ReactComponent} Component instance rendered in the container node.
         */
        constructAndRenderComponentByID: function(constructor, props, id) {
          var domNode = document.getElementById(id);
          ("production" !== "development" ? invariant(
            domNode,
            'Tried to get element with id of "%s" but it is not present on the page.',
            id
          ) : invariant(domNode));
          return ReactMount.constructAndRenderComponent(constructor, props, domNode);
        },
      
        /**
         * Registers a container node into which React components will be rendered.
         * This also creates the "reactRoot" ID that will be assigned to the element
         * rendered within.
         *
         * @param {DOMElement} container DOM element to register as a container.
         * @return {string} The "reactRoot" ID of elements rendered within.
         */
        registerContainer: function(container) {
          var reactRootID = getReactRootID(container);
          if (reactRootID) {
            // If one exists, make sure it is a valid "reactRoot" ID.
            reactRootID = ReactInstanceHandles.getReactRootIDFromNodeID(reactRootID);
          }
          if (!reactRootID) {
            // No valid "reactRoot" ID found, create one.
            reactRootID = ReactInstanceHandles.createReactRootID();
          }
          containersByReactRootID[reactRootID] = container;
          return reactRootID;
        },
      
        /**
         * Unmounts and destroys the React component rendered in the `container`.
         *
         * @param {DOMElement} container DOM element containing a React component.
         * @return {boolean} True if a component was found in and unmounted from
         *                   `container`
         */
        unmountComponentAtNode: function(container) {
          // Various parts of our code (such as ReactCompositeComponent's
          // _renderValidatedComponent) assume that calls to render aren't nested;
          // verify that that's the case. (Strictly speaking, unmounting won't cause a
          // render but we still don't expect to be in a render call here.)
          ("production" !== "development" ? warning(
            ReactCurrentOwner.current == null,
            'unmountComponentAtNode(): Render methods should be a pure function of ' +
            'props and state; triggering nested component updates from render is ' +
            'not allowed. If necessary, trigger nested updates in ' +
            'componentDidUpdate.'
          ) : null);
      
          var reactRootID = getReactRootID(container);
          var component = instancesByReactRootID[reactRootID];
          if (!component) {
            return false;
          }
          ReactMount.unmountComponentFromNode(component, container);
          delete instancesByReactRootID[reactRootID];
          delete containersByReactRootID[reactRootID];
          if ("production" !== "development") {
            delete rootElementsByReactRootID[reactRootID];
          }
          return true;
        },
      
        /**
         * Unmounts a component and removes it from the DOM.
         *
         * @param {ReactComponent} instance React component instance.
         * @param {DOMElement} container DOM element to unmount from.
         * @final
         * @internal
         * @see {ReactMount.unmountComponentAtNode}
         */
        unmountComponentFromNode: function(instance, container) {
          instance.unmountComponent();
      
          if (container.nodeType === DOC_NODE_TYPE) {
            container = container.documentElement;
          }
      
          // http://jsperf.com/emptying-a-node
          while (container.lastChild) {
            container.removeChild(container.lastChild);
          }
        },
      
        /**
         * Finds the container DOM element that contains React component to which the
         * supplied DOM `id` belongs.
         *
         * @param {string} id The ID of an element rendered by a React component.
         * @return {?DOMElement} DOM element that contains the `id`.
         */
        findReactContainerForID: function(id) {
          var reactRootID = ReactInstanceHandles.getReactRootIDFromNodeID(id);
          var container = containersByReactRootID[reactRootID];
      
          if ("production" !== "development") {
            var rootElement = rootElementsByReactRootID[reactRootID];
            if (rootElement && rootElement.parentNode !== container) {
              ("production" !== "development" ? invariant(
                // Call internalGetID here because getID calls isValid which calls
                // findReactContainerForID (this function).
                internalGetID(rootElement) === reactRootID,
                'ReactMount: Root element ID differed from reactRootID.'
              ) : invariant(// Call internalGetID here because getID calls isValid which calls
              // findReactContainerForID (this function).
              internalGetID(rootElement) === reactRootID));
      
              var containerChild = container.firstChild;
              if (containerChild &&
                  reactRootID === internalGetID(containerChild)) {
                // If the container has a new child with the same ID as the old
                // root element, then rootElementsByReactRootID[reactRootID] is
                // just stale and needs to be updated. The case that deserves a
                // warning is when the container is empty.
                rootElementsByReactRootID[reactRootID] = containerChild;
              } else {
                console.warn(
                  'ReactMount: Root element has been removed from its original ' +
                  'container. New container:', rootElement.parentNode
                );
              }
            }
          }
      
          return container;
        },
      
        /**
         * Finds an element rendered by React with the supplied ID.
         *
         * @param {string} id ID of a DOM node in the React component.
         * @return {DOMElement} Root DOM node of the React component.
         */
        findReactNodeByID: function(id) {
          var reactRoot = ReactMount.findReactContainerForID(id);
          return ReactMount.findComponentRoot(reactRoot, id);
        },
      
        /**
         * True if the supplied `node` is rendered by React.
         *
         * @param {*} node DOM Element to check.
         * @return {boolean} True if the DOM Element appears to be rendered by React.
         * @internal
         */
        isRenderedByReact: function(node) {
          if (node.nodeType !== 1) {
            // Not a DOMElement, therefore not a React component
            return false;
          }
          var id = ReactMount.getID(node);
          return id ? id.charAt(0) === SEPARATOR : false;
        },
      
        /**
         * Traverses up the ancestors of the supplied node to find a node that is a
         * DOM representation of a React component.
         *
         * @param {*} node
         * @return {?DOMEventTarget}
         * @internal
         */
        getFirstReactDOM: function(node) {
          var current = node;
          while (current && current.parentNode !== current) {
            if (ReactMount.isRenderedByReact(current)) {
              return current;
            }
            current = current.parentNode;
          }
          return null;
        },
      
        /**
         * Finds a node with the supplied `targetID` inside of the supplied
         * `ancestorNode`.  Exploits the ID naming scheme to perform the search
         * quickly.
         *
         * @param {DOMEventTarget} ancestorNode Search from this root.
         * @pararm {string} targetID ID of the DOM representation of the component.
         * @return {DOMEventTarget} DOM node with the supplied `targetID`.
         * @internal
         */
        findComponentRoot: function(ancestorNode, targetID) {
          var firstChildren = findComponentRootReusableArray;
          var childIndex = 0;
      
          var deepestAncestor = findDeepestCachedAncestor(targetID) || ancestorNode;
      
          firstChildren[0] = deepestAncestor.firstChild;
          firstChildren.length = 1;
      
          while (childIndex < firstChildren.length) {
            var child = firstChildren[childIndex++];
            var targetChild;
      
            while (child) {
              var childID = ReactMount.getID(child);
              if (childID) {
                // Even if we find the node we're looking for, we finish looping
                // through its siblings to ensure they're cached so that we don't have
                // to revisit this node again. Otherwise, we make n^2 calls to getID
                // when visiting the many children of a single node in order.
      
                if (targetID === childID) {
                  targetChild = child;
                } else if (ReactInstanceHandles.isAncestorIDOf(childID, targetID)) {
                  // If we find a child whose ID is an ancestor of the given ID,
                  // then we can be sure that we only want to search the subtree
                  // rooted at this child, so we can throw out the rest of the
                  // search state.
                  firstChildren.length = childIndex = 0;
                  firstChildren.push(child.firstChild);
                }
      
              } else {
                // If this child had no ID, then there's a chance that it was
                // injected automatically by the browser, as when a `<table>`
                // element sprouts an extra `<tbody>` child as a side effect of
                // `.innerHTML` parsing. Optimistically continue down this
                // branch, but not before examining the other siblings.
                firstChildren.push(child.firstChild);
              }
      
              child = child.nextSibling;
            }
      
            if (targetChild) {
              // Emptying firstChildren/findComponentRootReusableArray is
              // not necessary for correctness, but it helps the GC reclaim
              // any nodes that were left at the end of the search.
              firstChildren.length = 0;
      
              return targetChild;
            }
          }
      
          firstChildren.length = 0;
      
          ("production" !== "development" ? invariant(
            false,
            'findComponentRoot(..., %s): Unable to find element. This probably ' +
            'means the DOM was unexpectedly mutated (e.g., by the browser), ' +
            'usually due to forgetting a <tbody> when using tables, nesting <p> ' +
            'or <a> tags, or using non-SVG elements in an <svg> parent. Try ' +
            'inspecting the child nodes of the element with React ID `%s`.',
            targetID,
            ReactMount.getID(ancestorNode)
          ) : invariant(false));
        },
      
      
        /**
         * React ID utilities.
         */
      
        getReactRootID: getReactRootID,
      
        getID: getID,
      
        setID: setID,
      
        getNode: getNode,
      
        purgeID: purgeID
      };
      
      module.exports = ReactMount;
      
      },{"./DOMProperty":10,"./ReactBrowserEventEmitter":29,"./ReactCurrentOwner":35,"./ReactDescriptor":51,"./ReactInstanceHandles":59,"./ReactPerf":65,"./containsNode":96,"./getReactRootElementInContainer":114,"./instantiateReactComponent":119,"./invariant":120,"./shouldUpdateReactComponent":140,"./warning":143}],62:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactMultiChild
       * @typechecks static-only
       */
      
      "use strict";
      
      var ReactComponent = _dereq_("./ReactComponent");
      var ReactMultiChildUpdateTypes = _dereq_("./ReactMultiChildUpdateTypes");
      
      var flattenChildren = _dereq_("./flattenChildren");
      var instantiateReactComponent = _dereq_("./instantiateReactComponent");
      var shouldUpdateReactComponent = _dereq_("./shouldUpdateReactComponent");
      
      /**
       * Updating children of a component may trigger recursive updates. The depth is
       * used to batch recursive updates to render markup more efficiently.
       *
       * @type {number}
       * @private
       */
      var updateDepth = 0;
      
      /**
       * Queue of update configuration objects.
       *
       * Each object has a `type` property that is in `ReactMultiChildUpdateTypes`.
       *
       * @type {array<object>}
       * @private
       */
      var updateQueue = [];
      
      /**
       * Queue of markup to be rendered.
       *
       * @type {array<string>}
       * @private
       */
      var markupQueue = [];
      
      /**
       * Enqueues markup to be rendered and inserted at a supplied index.
       *
       * @param {string} parentID ID of the parent component.
       * @param {string} markup Markup that renders into an element.
       * @param {number} toIndex Destination index.
       * @private
       */
      function enqueueMarkup(parentID, markup, toIndex) {
        // NOTE: Null values reduce hidden classes.
        updateQueue.push({
          parentID: parentID,
          parentNode: null,
          type: ReactMultiChildUpdateTypes.INSERT_MARKUP,
          markupIndex: markupQueue.push(markup) - 1,
          textContent: null,
          fromIndex: null,
          toIndex: toIndex
        });
      }
      
      /**
       * Enqueues moving an existing element to another index.
       *
       * @param {string} parentID ID of the parent component.
       * @param {number} fromIndex Source index of the existing element.
       * @param {number} toIndex Destination index of the element.
       * @private
       */
      function enqueueMove(parentID, fromIndex, toIndex) {
        // NOTE: Null values reduce hidden classes.
        updateQueue.push({
          parentID: parentID,
          parentNode: null,
          type: ReactMultiChildUpdateTypes.MOVE_EXISTING,
          markupIndex: null,
          textContent: null,
          fromIndex: fromIndex,
          toIndex: toIndex
        });
      }
      
      /**
       * Enqueues removing an element at an index.
       *
       * @param {string} parentID ID of the parent component.
       * @param {number} fromIndex Index of the element to remove.
       * @private
       */
      function enqueueRemove(parentID, fromIndex) {
        // NOTE: Null values reduce hidden classes.
        updateQueue.push({
          parentID: parentID,
          parentNode: null,
          type: ReactMultiChildUpdateTypes.REMOVE_NODE,
          markupIndex: null,
          textContent: null,
          fromIndex: fromIndex,
          toIndex: null
        });
      }
      
      /**
       * Enqueues setting the text content.
       *
       * @param {string} parentID ID of the parent component.
       * @param {string} textContent Text content to set.
       * @private
       */
      function enqueueTextContent(parentID, textContent) {
        // NOTE: Null values reduce hidden classes.
        updateQueue.push({
          parentID: parentID,
          parentNode: null,
          type: ReactMultiChildUpdateTypes.TEXT_CONTENT,
          markupIndex: null,
          textContent: textContent,
          fromIndex: null,
          toIndex: null
        });
      }
      
      /**
       * Processes any enqueued updates.
       *
       * @private
       */
      function processQueue() {
        if (updateQueue.length) {
          ReactComponent.BackendIDOperations.dangerouslyProcessChildrenUpdates(
            updateQueue,
            markupQueue
          );
          clearQueue();
        }
      }
      
      /**
       * Clears any enqueued updates.
       *
       * @private
       */
      function clearQueue() {
        updateQueue.length = 0;
        markupQueue.length = 0;
      }
      
      /**
       * ReactMultiChild are capable of reconciling multiple children.
       *
       * @class ReactMultiChild
       * @internal
       */
      var ReactMultiChild = {
      
        /**
         * Provides common functionality for components that must reconcile multiple
         * children. This is used by `ReactDOMComponent` to mount, update, and
         * unmount child components.
         *
         * @lends {ReactMultiChild.prototype}
         */
        Mixin: {
      
          /**
           * Generates a "mount image" for each of the supplied children. In the case
           * of `ReactDOMComponent`, a mount image is a string of markup.
           *
           * @param {?object} nestedChildren Nested child maps.
           * @return {array} An array of mounted representations.
           * @internal
           */
          mountChildren: function(nestedChildren, transaction) {
            var children = flattenChildren(nestedChildren);
            var mountImages = [];
            var index = 0;
            this._renderedChildren = children;
            for (var name in children) {
              var child = children[name];
              if (children.hasOwnProperty(name)) {
                // The rendered children must be turned into instances as they're
                // mounted.
                var childInstance = instantiateReactComponent(child);
                children[name] = childInstance;
                // Inlined for performance, see `ReactInstanceHandles.createReactID`.
                var rootID = this._rootNodeID + name;
                var mountImage = childInstance.mountComponent(
                  rootID,
                  transaction,
                  this._mountDepth + 1
                );
                childInstance._mountIndex = index;
                mountImages.push(mountImage);
                index++;
              }
            }
            return mountImages;
          },
      
          /**
           * Replaces any rendered children with a text content string.
           *
           * @param {string} nextContent String of content.
           * @internal
           */
          updateTextContent: function(nextContent) {
            updateDepth++;
            var errorThrown = true;
            try {
              var prevChildren = this._renderedChildren;
              // Remove any rendered children.
              for (var name in prevChildren) {
                if (prevChildren.hasOwnProperty(name)) {
                  this._unmountChildByName(prevChildren[name], name);
                }
              }
              // Set new text content.
              this.setTextContent(nextContent);
              errorThrown = false;
            } finally {
              updateDepth--;
              if (!updateDepth) {
                errorThrown ? clearQueue() : processQueue();
              }
            }
          },
      
          /**
           * Updates the rendered children with new children.
           *
           * @param {?object} nextNestedChildren Nested child maps.
           * @param {ReactReconcileTransaction} transaction
           * @internal
           */
          updateChildren: function(nextNestedChildren, transaction) {
            updateDepth++;
            var errorThrown = true;
            try {
              this._updateChildren(nextNestedChildren, transaction);
              errorThrown = false;
            } finally {
              updateDepth--;
              if (!updateDepth) {
                errorThrown ? clearQueue() : processQueue();
              }
            }
          },
      
          /**
           * Improve performance by isolating this hot code path from the try/catch
           * block in `updateChildren`.
           *
           * @param {?object} nextNestedChildren Nested child maps.
           * @param {ReactReconcileTransaction} transaction
           * @final
           * @protected
           */
          _updateChildren: function(nextNestedChildren, transaction) {
            var nextChildren = flattenChildren(nextNestedChildren);
            var prevChildren = this._renderedChildren;
            if (!nextChildren && !prevChildren) {
              return;
            }
            var name;
            // `nextIndex` will increment for each child in `nextChildren`, but
            // `lastIndex` will be the last index visited in `prevChildren`.
            var lastIndex = 0;
            var nextIndex = 0;
            for (name in nextChildren) {
              if (!nextChildren.hasOwnProperty(name)) {
                continue;
              }
              var prevChild = prevChildren && prevChildren[name];
              var prevDescriptor = prevChild && prevChild._descriptor;
              var nextDescriptor = nextChildren[name];
              if (shouldUpdateReactComponent(prevDescriptor, nextDescriptor)) {
                this.moveChild(prevChild, nextIndex, lastIndex);
                lastIndex = Math.max(prevChild._mountIndex, lastIndex);
                prevChild.receiveComponent(nextDescriptor, transaction);
                prevChild._mountIndex = nextIndex;
              } else {
                if (prevChild) {
                  // Update `lastIndex` before `_mountIndex` gets unset by unmounting.
                  lastIndex = Math.max(prevChild._mountIndex, lastIndex);
                  this._unmountChildByName(prevChild, name);
                }
                // The child must be instantiated before it's mounted.
                var nextChildInstance = instantiateReactComponent(nextDescriptor);
                this._mountChildByNameAtIndex(
                  nextChildInstance, name, nextIndex, transaction
                );
              }
              nextIndex++;
            }
            // Remove children that are no longer present.
            for (name in prevChildren) {
              if (prevChildren.hasOwnProperty(name) &&
                  !(nextChildren && nextChildren[name])) {
                this._unmountChildByName(prevChildren[name], name);
              }
            }
          },
      
          /**
           * Unmounts all rendered children. This should be used to clean up children
           * when this component is unmounted.
           *
           * @internal
           */
          unmountChildren: function() {
            var renderedChildren = this._renderedChildren;
            for (var name in renderedChildren) {
              var renderedChild = renderedChildren[name];
              // TODO: When is this not true?
              if (renderedChild.unmountComponent) {
                renderedChild.unmountComponent();
              }
            }
            this._renderedChildren = null;
          },
      
          /**
           * Moves a child component to the supplied index.
           *
           * @param {ReactComponent} child Component to move.
           * @param {number} toIndex Destination index of the element.
           * @param {number} lastIndex Last index visited of the siblings of `child`.
           * @protected
           */
          moveChild: function(child, toIndex, lastIndex) {
            // If the index of `child` is less than `lastIndex`, then it needs to
            // be moved. Otherwise, we do not need to move it because a child will be
            // inserted or moved before `child`.
            if (child._mountIndex < lastIndex) {
              enqueueMove(this._rootNodeID, child._mountIndex, toIndex);
            }
          },
      
          /**
           * Creates a child component.
           *
           * @param {ReactComponent} child Component to create.
           * @param {string} mountImage Markup to insert.
           * @protected
           */
          createChild: function(child, mountImage) {
            enqueueMarkup(this._rootNodeID, mountImage, child._mountIndex);
          },
      
          /**
           * Removes a child component.
           *
           * @param {ReactComponent} child Child to remove.
           * @protected
           */
          removeChild: function(child) {
            enqueueRemove(this._rootNodeID, child._mountIndex);
          },
      
          /**
           * Sets this text content string.
           *
           * @param {string} textContent Text content to set.
           * @protected
           */
          setTextContent: function(textContent) {
            enqueueTextContent(this._rootNodeID, textContent);
          },
      
          /**
           * Mounts a child with the supplied name.
           *
           * NOTE: This is part of `updateChildren` and is here for readability.
           *
           * @param {ReactComponent} child Component to mount.
           * @param {string} name Name of the child.
           * @param {number} index Index at which to insert the child.
           * @param {ReactReconcileTransaction} transaction
           * @private
           */
          _mountChildByNameAtIndex: function(child, name, index, transaction) {
            // Inlined for performance, see `ReactInstanceHandles.createReactID`.
            var rootID = this._rootNodeID + name;
            var mountImage = child.mountComponent(
              rootID,
              transaction,
              this._mountDepth + 1
            );
            child._mountIndex = index;
            this.createChild(child, mountImage);
            this._renderedChildren = this._renderedChildren || {};
            this._renderedChildren[name] = child;
          },
      
          /**
           * Unmounts a rendered child by name.
           *
           * NOTE: This is part of `updateChildren` and is here for readability.
           *
           * @param {ReactComponent} child Component to unmount.
           * @param {string} name Name of the child in `this._renderedChildren`.
           * @private
           */
          _unmountChildByName: function(child, name) {
            this.removeChild(child);
            child._mountIndex = null;
            child.unmountComponent();
            delete this._renderedChildren[name];
          }
      
        }
      
      };
      
      module.exports = ReactMultiChild;
      
      },{"./ReactComponent":31,"./ReactMultiChildUpdateTypes":63,"./flattenChildren":105,"./instantiateReactComponent":119,"./shouldUpdateReactComponent":140}],63:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactMultiChildUpdateTypes
       */
      
      "use strict";
      
      var keyMirror = _dereq_("./keyMirror");
      
      /**
       * When a component's children are updated, a series of update configuration
       * objects are created in order to batch and serialize the required changes.
       *
       * Enumerates all the possible types of update configurations.
       *
       * @internal
       */
      var ReactMultiChildUpdateTypes = keyMirror({
        INSERT_MARKUP: null,
        MOVE_EXISTING: null,
        REMOVE_NODE: null,
        TEXT_CONTENT: null
      });
      
      module.exports = ReactMultiChildUpdateTypes;
      
      },{"./keyMirror":126}],64:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactOwner
       */
      
      "use strict";
      
      var emptyObject = _dereq_("./emptyObject");
      var invariant = _dereq_("./invariant");
      
      /**
       * ReactOwners are capable of storing references to owned components.
       *
       * All components are capable of //being// referenced by owner components, but
       * only ReactOwner components are capable of //referencing// owned components.
       * The named reference is known as a "ref".
       *
       * Refs are available when mounted and updated during reconciliation.
       *
       *   var MyComponent = React.createClass({
       *     render: function() {
       *       return (
       *         <div onClick={this.handleClick}>
       *           <CustomComponent ref="custom" />
       *         </div>
       *       );
       *     },
       *     handleClick: function() {
       *       this.refs.custom.handleClick();
       *     },
       *     componentDidMount: function() {
       *       this.refs.custom.initialize();
       *     }
       *   });
       *
       * Refs should rarely be used. When refs are used, they should only be done to
       * control data that is not handled by React's data flow.
       *
       * @class ReactOwner
       */
      var ReactOwner = {
      
        /**
         * @param {?object} object
         * @return {boolean} True if `object` is a valid owner.
         * @final
         */
        isValidOwner: function(object) {
          return !!(
            object &&
            typeof object.attachRef === 'function' &&
            typeof object.detachRef === 'function'
          );
        },
      
        /**
         * Adds a component by ref to an owner component.
         *
         * @param {ReactComponent} component Component to reference.
         * @param {string} ref Name by which to refer to the component.
         * @param {ReactOwner} owner Component on which to record the ref.
         * @final
         * @internal
         */
        addComponentAsRefTo: function(component, ref, owner) {
          ("production" !== "development" ? invariant(
            ReactOwner.isValidOwner(owner),
            'addComponentAsRefTo(...): Only a ReactOwner can have refs. This ' +
            'usually means that you\'re trying to add a ref to a component that ' +
            'doesn\'t have an owner (that is, was not created inside of another ' +
            'component\'s `render` method). Try rendering this component inside of ' +
            'a new top-level component which will hold the ref.'
          ) : invariant(ReactOwner.isValidOwner(owner)));
          owner.attachRef(ref, component);
        },
      
        /**
         * Removes a component by ref from an owner component.
         *
         * @param {ReactComponent} component Component to dereference.
         * @param {string} ref Name of the ref to remove.
         * @param {ReactOwner} owner Component on which the ref is recorded.
         * @final
         * @internal
         */
        removeComponentAsRefFrom: function(component, ref, owner) {
          ("production" !== "development" ? invariant(
            ReactOwner.isValidOwner(owner),
            'removeComponentAsRefFrom(...): Only a ReactOwner can have refs. This ' +
            'usually means that you\'re trying to remove a ref to a component that ' +
            'doesn\'t have an owner (that is, was not created inside of another ' +
            'component\'s `render` method). Try rendering this component inside of ' +
            'a new top-level component which will hold the ref.'
          ) : invariant(ReactOwner.isValidOwner(owner)));
          // Check that `component` is still the current ref because we do not want to
          // detach the ref if another component stole it.
          if (owner.refs[ref] === component) {
            owner.detachRef(ref);
          }
        },
      
        /**
         * A ReactComponent must mix this in to have refs.
         *
         * @lends {ReactOwner.prototype}
         */
        Mixin: {
      
          construct: function() {
            this.refs = emptyObject;
          },
      
          /**
           * Lazily allocates the refs object and stores `component` as `ref`.
           *
           * @param {string} ref Reference name.
           * @param {component} component Component to store as `ref`.
           * @final
           * @private
           */
          attachRef: function(ref, component) {
            ("production" !== "development" ? invariant(
              component.isOwnedBy(this),
              'attachRef(%s, ...): Only a component\'s owner can store a ref to it.',
              ref
            ) : invariant(component.isOwnedBy(this)));
            var refs = this.refs === emptyObject ? (this.refs = {}) : this.refs;
            refs[ref] = component;
          },
      
          /**
           * Detaches a reference name.
           *
           * @param {string} ref Name to dereference.
           * @final
           * @private
           */
          detachRef: function(ref) {
            delete this.refs[ref];
          }
      
        }
      
      };
      
      module.exports = ReactOwner;
      
      },{"./emptyObject":103,"./invariant":120}],65:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactPerf
       * @typechecks static-only
       */
      
      "use strict";
      
      /**
       * ReactPerf is a general AOP system designed to measure performance. This
       * module only has the hooks: see ReactDefaultPerf for the analysis tool.
       */
      var ReactPerf = {
        /**
         * Boolean to enable/disable measurement. Set to false by default to prevent
         * accidental logging and perf loss.
         */
        enableMeasure: false,
      
        /**
         * Holds onto the measure function in use. By default, don't measure
         * anything, but we'll override this if we inject a measure function.
         */
        storedMeasure: _noMeasure,
      
        /**
         * Use this to wrap methods you want to measure. Zero overhead in production.
         *
         * @param {string} objName
         * @param {string} fnName
         * @param {function} func
         * @return {function}
         */
        measure: function(objName, fnName, func) {
          if ("production" !== "development") {
            var measuredFunc = null;
            return function() {
              if (ReactPerf.enableMeasure) {
                if (!measuredFunc) {
                  measuredFunc = ReactPerf.storedMeasure(objName, fnName, func);
                }
                return measuredFunc.apply(this, arguments);
              }
              return func.apply(this, arguments);
            };
          }
          return func;
        },
      
        injection: {
          /**
           * @param {function} measure
           */
          injectMeasure: function(measure) {
            ReactPerf.storedMeasure = measure;
          }
        }
      };
      
      /**
       * Simply passes through the measured function, without measuring it.
       *
       * @param {string} objName
       * @param {string} fnName
       * @param {function} func
       * @return {function}
       */
      function _noMeasure(objName, fnName, func) {
        return func;
      }
      
      module.exports = ReactPerf;
      
      },{}],66:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactPropTransferer
       */
      
      "use strict";
      
      var emptyFunction = _dereq_("./emptyFunction");
      var invariant = _dereq_("./invariant");
      var joinClasses = _dereq_("./joinClasses");
      var merge = _dereq_("./merge");
      
      /**
       * Creates a transfer strategy that will merge prop values using the supplied
       * `mergeStrategy`. If a prop was previously unset, this just sets it.
       *
       * @param {function} mergeStrategy
       * @return {function}
       */
      function createTransferStrategy(mergeStrategy) {
        return function(props, key, value) {
          if (!props.hasOwnProperty(key)) {
            props[key] = value;
          } else {
            props[key] = mergeStrategy(props[key], value);
          }
        };
      }
      
      var transferStrategyMerge = createTransferStrategy(function(a, b) {
        // `merge` overrides the first object's (`props[key]` above) keys using the
        // second object's (`value`) keys. An object's style's existing `propA` would
        // get overridden. Flip the order here.
        return merge(b, a);
      });
      
      /**
       * Transfer strategies dictate how props are transferred by `transferPropsTo`.
       * NOTE: if you add any more exceptions to this list you should be sure to
       * update `cloneWithProps()` accordingly.
       */
      var TransferStrategies = {
        /**
         * Never transfer `children`.
         */
        children: emptyFunction,
        /**
         * Transfer the `className` prop by merging them.
         */
        className: createTransferStrategy(joinClasses),
        /**
         * Never transfer the `key` prop.
         */
        key: emptyFunction,
        /**
         * Never transfer the `ref` prop.
         */
        ref: emptyFunction,
        /**
         * Transfer the `style` prop (which is an object) by merging them.
         */
        style: transferStrategyMerge
      };
      
      /**
       * Mutates the first argument by transferring the properties from the second
       * argument.
       *
       * @param {object} props
       * @param {object} newProps
       * @return {object}
       */
      function transferInto(props, newProps) {
        for (var thisKey in newProps) {
          if (!newProps.hasOwnProperty(thisKey)) {
            continue;
          }
      
          var transferStrategy = TransferStrategies[thisKey];
      
          if (transferStrategy && TransferStrategies.hasOwnProperty(thisKey)) {
            transferStrategy(props, thisKey, newProps[thisKey]);
          } else if (!props.hasOwnProperty(thisKey)) {
            props[thisKey] = newProps[thisKey];
          }
        }
        return props;
      }
      
      /**
       * ReactPropTransferer are capable of transferring props to another component
       * using a `transferPropsTo` method.
       *
       * @class ReactPropTransferer
       */
      var ReactPropTransferer = {
      
        TransferStrategies: TransferStrategies,
      
        /**
         * Merge two props objects using TransferStrategies.
         *
         * @param {object} oldProps original props (they take precedence)
         * @param {object} newProps new props to merge in
         * @return {object} a new object containing both sets of props merged.
         */
        mergeProps: function(oldProps, newProps) {
          return transferInto(merge(oldProps), newProps);
        },
      
        /**
         * @lends {ReactPropTransferer.prototype}
         */
        Mixin: {
      
          /**
           * Transfer props from this component to a target component.
           *
           * Props that do not have an explicit transfer strategy will be transferred
           * only if the target component does not already have the prop set.
           *
           * This is usually used to pass down props to a returned root component.
           *
           * @param {ReactDescriptor} descriptor Component receiving the properties.
           * @return {ReactDescriptor} The supplied `component`.
           * @final
           * @protected
           */
          transferPropsTo: function(descriptor) {
            ("production" !== "development" ? invariant(
              descriptor._owner === this,
              '%s: You can\'t call transferPropsTo() on a component that you ' +
              'don\'t own, %s. This usually means you are calling ' +
              'transferPropsTo() on a component passed in as props or children.',
              this.constructor.displayName,
              descriptor.type.displayName
            ) : invariant(descriptor._owner === this));
      
            // Because descriptors are immutable we have to merge into the existing
            // props object rather than clone it.
            transferInto(descriptor.props, this.props);
      
            return descriptor;
          }
      
        }
      };
      
      module.exports = ReactPropTransferer;
      
      },{"./emptyFunction":102,"./invariant":120,"./joinClasses":125,"./merge":130}],67:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactPropTypeLocationNames
       */
      
      "use strict";
      
      var ReactPropTypeLocationNames = {};
      
      if ("production" !== "development") {
        ReactPropTypeLocationNames = {
          prop: 'prop',
          context: 'context',
          childContext: 'child context'
        };
      }
      
      module.exports = ReactPropTypeLocationNames;
      
      },{}],68:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactPropTypeLocations
       */
      
      "use strict";
      
      var keyMirror = _dereq_("./keyMirror");
      
      var ReactPropTypeLocations = keyMirror({
        prop: null,
        context: null,
        childContext: null
      });
      
      module.exports = ReactPropTypeLocations;
      
      },{"./keyMirror":126}],69:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactPropTypes
       */
      
      "use strict";
      
      var ReactDescriptor = _dereq_("./ReactDescriptor");
      var ReactPropTypeLocationNames = _dereq_("./ReactPropTypeLocationNames");
      
      var emptyFunction = _dereq_("./emptyFunction");
      
      /**
       * Collection of methods that allow declaration and validation of props that are
       * supplied to React components. Example usage:
       *
       *   var Props = require('ReactPropTypes');
       *   var MyArticle = React.createClass({
       *     propTypes: {
       *       // An optional string prop named "description".
       *       description: Props.string,
       *
       *       // A required enum prop named "category".
       *       category: Props.oneOf(['News','Photos']).isRequired,
       *
       *       // A prop named "dialog" that requires an instance of Dialog.
       *       dialog: Props.instanceOf(Dialog).isRequired
       *     },
       *     render: function() { ... }
       *   });
       *
       * A more formal specification of how these methods are used:
       *
       *   type := array|bool|func|object|number|string|oneOf([...])|instanceOf(...)
       *   decl := ReactPropTypes.{type}(.isRequired)?
       *
       * Each and every declaration produces a function with the same signature. This
       * allows the creation of custom validation functions. For example:
       *
       *  var MyLink = React.createClass({
       *    propTypes: {
       *      // An optional string or URI prop named "href".
       *      href: function(props, propName, componentName) {
       *        var propValue = props[propName];
       *        if (propValue != null && typeof propValue !== 'string' &&
       *            !(propValue instanceof URI)) {
       *          return new Error(
       *            'Expected a string or an URI for ' + propName + ' in ' +
       *            componentName
       *          );
       *        }
       *      }
       *    },
       *    render: function() {...}
       *  });
       *
       * @internal
       */
      
      var ANONYMOUS = '<<anonymous>>';
      
      var ReactPropTypes = {
        array: createPrimitiveTypeChecker('array'),
        bool: createPrimitiveTypeChecker('boolean'),
        func: createPrimitiveTypeChecker('function'),
        number: createPrimitiveTypeChecker('number'),
        object: createPrimitiveTypeChecker('object'),
        string: createPrimitiveTypeChecker('string'),
      
        any: createAnyTypeChecker(),
        arrayOf: createArrayOfTypeChecker,
        component: createComponentTypeChecker(),
        instanceOf: createInstanceTypeChecker,
        objectOf: createObjectOfTypeChecker,
        oneOf: createEnumTypeChecker,
        oneOfType: createUnionTypeChecker,
        renderable: createRenderableTypeChecker(),
        shape: createShapeTypeChecker
      };
      
      function createChainableTypeChecker(validate) {
        function checkType(isRequired, props, propName, componentName, location) {
          componentName = componentName || ANONYMOUS;
          if (props[propName] == null) {
            var locationName = ReactPropTypeLocationNames[location];
            if (isRequired) {
              return new Error(
                ("Required " + locationName + " `" + propName + "` was not specified in ")+
                ("`" + componentName + "`.")
              );
            }
          } else {
            return validate(props, propName, componentName, location);
          }
        }
      
        var chainedCheckType = checkType.bind(null, false);
        chainedCheckType.isRequired = checkType.bind(null, true);
      
        return chainedCheckType;
      }
      
      function createPrimitiveTypeChecker(expectedType) {
        function validate(props, propName, componentName, location) {
          var propValue = props[propName];
          var propType = getPropType(propValue);
          if (propType !== expectedType) {
            var locationName = ReactPropTypeLocationNames[location];
            // `propValue` being instance of, say, date/regexp, pass the 'object'
            // check, but we can offer a more precise error message here rather than
            // 'of type `object`'.
            var preciseType = getPreciseType(propValue);
      
            return new Error(
              ("Invalid " + locationName + " `" + propName + "` of type `" + preciseType + "` ") +
              ("supplied to `" + componentName + "`, expected `" + expectedType + "`.")
            );
          }
        }
        return createChainableTypeChecker(validate);
      }
      
      function createAnyTypeChecker() {
        return createChainableTypeChecker(emptyFunction.thatReturns());
      }
      
      function createArrayOfTypeChecker(typeChecker) {
        function validate(props, propName, componentName, location) {
          var propValue = props[propName];
          if (!Array.isArray(propValue)) {
            var locationName = ReactPropTypeLocationNames[location];
            var propType = getPropType(propValue);
            return new Error(
              ("Invalid " + locationName + " `" + propName + "` of type ") +
              ("`" + propType + "` supplied to `" + componentName + "`, expected an array.")
            );
          }
          for (var i = 0; i < propValue.length; i++) {
            var error = typeChecker(propValue, i, componentName, location);
            if (error instanceof Error) {
              return error;
            }
          }
        }
        return createChainableTypeChecker(validate);
      }
      
      function createComponentTypeChecker() {
        function validate(props, propName, componentName, location) {
          if (!ReactDescriptor.isValidDescriptor(props[propName])) {
            var locationName = ReactPropTypeLocationNames[location];
            return new Error(
              ("Invalid " + locationName + " `" + propName + "` supplied to ") +
              ("`" + componentName + "`, expected a React component.")
            );
          }
        }
        return createChainableTypeChecker(validate);
      }
      
      function createInstanceTypeChecker(expectedClass) {
        function validate(props, propName, componentName, location) {
          if (!(props[propName] instanceof expectedClass)) {
            var locationName = ReactPropTypeLocationNames[location];
            var expectedClassName = expectedClass.name || ANONYMOUS;
            return new Error(
              ("Invalid " + locationName + " `" + propName + "` supplied to ") +
              ("`" + componentName + "`, expected instance of `" + expectedClassName + "`.")
            );
          }
        }
        return createChainableTypeChecker(validate);
      }
      
      function createEnumTypeChecker(expectedValues) {
        function validate(props, propName, componentName, location) {
          var propValue = props[propName];
          for (var i = 0; i < expectedValues.length; i++) {
            if (propValue === expectedValues[i]) {
              return;
            }
          }
      
          var locationName = ReactPropTypeLocationNames[location];
          var valuesString = JSON.stringify(expectedValues);
          return new Error(
            ("Invalid " + locationName + " `" + propName + "` of value `" + propValue + "` ") +
            ("supplied to `" + componentName + "`, expected one of " + valuesString + ".")
          );
        }
        return createChainableTypeChecker(validate);
      }
      
      function createObjectOfTypeChecker(typeChecker) {
        function validate(props, propName, componentName, location) {
          var propValue = props[propName];
          var propType = getPropType(propValue);
          if (propType !== 'object') {
            var locationName = ReactPropTypeLocationNames[location];
            return new Error(
              ("Invalid " + locationName + " `" + propName + "` of type ") +
              ("`" + propType + "` supplied to `" + componentName + "`, expected an object.")
            );
          }
          for (var key in propValue) {
            if (propValue.hasOwnProperty(key)) {
              var error = typeChecker(propValue, key, componentName, location);
              if (error instanceof Error) {
                return error;
              }
            }
          }
        }
        return createChainableTypeChecker(validate);
      }
      
      function createUnionTypeChecker(arrayOfTypeCheckers) {
        function validate(props, propName, componentName, location) {
          for (var i = 0; i < arrayOfTypeCheckers.length; i++) {
            var checker = arrayOfTypeCheckers[i];
            if (checker(props, propName, componentName, location) == null) {
              return;
            }
          }
      
          var locationName = ReactPropTypeLocationNames[location];
          return new Error(
            ("Invalid " + locationName + " `" + propName + "` supplied to ") +
            ("`" + componentName + "`.")
          );
        }
        return createChainableTypeChecker(validate);
      }
      
      function createRenderableTypeChecker() {
        function validate(props, propName, componentName, location) {
          if (!isRenderable(props[propName])) {
            var locationName = ReactPropTypeLocationNames[location];
            return new Error(
              ("Invalid " + locationName + " `" + propName + "` supplied to ") +
              ("`" + componentName + "`, expected a renderable prop.")
            );
          }
        }
        return createChainableTypeChecker(validate);
      }
      
      function createShapeTypeChecker(shapeTypes) {
        function validate(props, propName, componentName, location) {
          var propValue = props[propName];
          var propType = getPropType(propValue);
          if (propType !== 'object') {
            var locationName = ReactPropTypeLocationNames[location];
            return new Error(
              ("Invalid " + locationName + " `" + propName + "` of type `" + propType + "` ") +
              ("supplied to `" + componentName + "`, expected `object`.")
            );
          }
          for (var key in shapeTypes) {
            var checker = shapeTypes[key];
            if (!checker) {
              continue;
            }
            var error = checker(propValue, key, componentName, location);
            if (error) {
              return error;
            }
          }
        }
        return createChainableTypeChecker(validate, 'expected `object`');
      }
      
      function isRenderable(propValue) {
        switch(typeof propValue) {
          // TODO: this was probably written with the assumption that we're not
          // returning `this.props.component` directly from `render`. This is
          // currently not supported but we should, to make it consistent.
          case 'number':
          case 'string':
            return true;
          case 'boolean':
            return !propValue;
          case 'object':
            if (Array.isArray(propValue)) {
              return propValue.every(isRenderable);
            }
            if (ReactDescriptor.isValidDescriptor(propValue)) {
              return true;
            }
            for (var k in propValue) {
              if (!isRenderable(propValue[k])) {
                return false;
              }
            }
            return true;
          default:
            return false;
        }
      }
      
      // Equivalent of `typeof` but with special handling for array and regexp.
      function getPropType(propValue) {
        var propType = typeof propValue;
        if (Array.isArray(propValue)) {
          return 'array';
        }
        if (propValue instanceof RegExp) {
          // Old webkits (at least until Android 4.0) return 'function' rather than
          // 'object' for typeof a RegExp. We'll normalize this here so that /bla/
          // passes PropTypes.object.
          return 'object';
        }
        return propType;
      }
      
      // This handles more types than `getPropType`. Only used for error messages.
      // See `createPrimitiveTypeChecker`.
      function getPreciseType(propValue) {
        var propType = getPropType(propValue);
        if (propType === 'object') {
          if (propValue instanceof Date) {
            return 'date';
          } else if (propValue instanceof RegExp) {
            return 'regexp';
          }
        }
        return propType;
      }
      
      module.exports = ReactPropTypes;
      
      },{"./ReactDescriptor":51,"./ReactPropTypeLocationNames":67,"./emptyFunction":102}],70:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactPutListenerQueue
       */
      
      "use strict";
      
      var PooledClass = _dereq_("./PooledClass");
      var ReactBrowserEventEmitter = _dereq_("./ReactBrowserEventEmitter");
      
      var mixInto = _dereq_("./mixInto");
      
      function ReactPutListenerQueue() {
        this.listenersToPut = [];
      }
      
      mixInto(ReactPutListenerQueue, {
        enqueuePutListener: function(rootNodeID, propKey, propValue) {
          this.listenersToPut.push({
            rootNodeID: rootNodeID,
            propKey: propKey,
            propValue: propValue
          });
        },
      
        putListeners: function() {
          for (var i = 0; i < this.listenersToPut.length; i++) {
            var listenerToPut = this.listenersToPut[i];
            ReactBrowserEventEmitter.putListener(
              listenerToPut.rootNodeID,
              listenerToPut.propKey,
              listenerToPut.propValue
            );
          }
        },
      
        reset: function() {
          this.listenersToPut.length = 0;
        },
      
        destructor: function() {
          this.reset();
        }
      });
      
      PooledClass.addPoolingTo(ReactPutListenerQueue);
      
      module.exports = ReactPutListenerQueue;
      
      },{"./PooledClass":26,"./ReactBrowserEventEmitter":29,"./mixInto":133}],71:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactReconcileTransaction
       * @typechecks static-only
       */
      
      "use strict";
      
      var CallbackQueue = _dereq_("./CallbackQueue");
      var PooledClass = _dereq_("./PooledClass");
      var ReactBrowserEventEmitter = _dereq_("./ReactBrowserEventEmitter");
      var ReactInputSelection = _dereq_("./ReactInputSelection");
      var ReactPutListenerQueue = _dereq_("./ReactPutListenerQueue");
      var Transaction = _dereq_("./Transaction");
      
      var mixInto = _dereq_("./mixInto");
      
      /**
       * Ensures that, when possible, the selection range (currently selected text
       * input) is not disturbed by performing the transaction.
       */
      var SELECTION_RESTORATION = {
        /**
         * @return {Selection} Selection information.
         */
        initialize: ReactInputSelection.getSelectionInformation,
        /**
         * @param {Selection} sel Selection information returned from `initialize`.
         */
        close: ReactInputSelection.restoreSelection
      };
      
      /**
       * Suppresses events (blur/focus) that could be inadvertently dispatched due to
       * high level DOM manipulations (like temporarily removing a text input from the
       * DOM).
       */
      var EVENT_SUPPRESSION = {
        /**
         * @return {boolean} The enabled status of `ReactBrowserEventEmitter` before
         * the reconciliation.
         */
        initialize: function() {
          var currentlyEnabled = ReactBrowserEventEmitter.isEnabled();
          ReactBrowserEventEmitter.setEnabled(false);
          return currentlyEnabled;
        },
      
        /**
         * @param {boolean} previouslyEnabled Enabled status of
         *   `ReactBrowserEventEmitter` before the reconciliation occured. `close`
         *   restores the previous value.
         */
        close: function(previouslyEnabled) {
          ReactBrowserEventEmitter.setEnabled(previouslyEnabled);
        }
      };
      
      /**
       * Provides a queue for collecting `componentDidMount` and
       * `componentDidUpdate` callbacks during the the transaction.
       */
      var ON_DOM_READY_QUEUEING = {
        /**
         * Initializes the internal `onDOMReady` queue.
         */
        initialize: function() {
          this.reactMountReady.reset();
        },
      
        /**
         * After DOM is flushed, invoke all registered `onDOMReady` callbacks.
         */
        close: function() {
          this.reactMountReady.notifyAll();
        }
      };
      
      var PUT_LISTENER_QUEUEING = {
        initialize: function() {
          this.putListenerQueue.reset();
        },
      
        close: function() {
          this.putListenerQueue.putListeners();
        }
      };
      
      /**
       * Executed within the scope of the `Transaction` instance. Consider these as
       * being member methods, but with an implied ordering while being isolated from
       * each other.
       */
      var TRANSACTION_WRAPPERS = [
        PUT_LISTENER_QUEUEING,
        SELECTION_RESTORATION,
        EVENT_SUPPRESSION,
        ON_DOM_READY_QUEUEING
      ];
      
      /**
       * Currently:
       * - The order that these are listed in the transaction is critical:
       * - Suppresses events.
       * - Restores selection range.
       *
       * Future:
       * - Restore document/overflow scroll positions that were unintentionally
       *   modified via DOM insertions above the top viewport boundary.
       * - Implement/integrate with customized constraint based layout system and keep
       *   track of which dimensions must be remeasured.
       *
       * @class ReactReconcileTransaction
       */
      function ReactReconcileTransaction() {
        this.reinitializeTransaction();
        // Only server-side rendering really needs this option (see
        // `ReactServerRendering`), but server-side uses
        // `ReactServerRenderingTransaction` instead. This option is here so that it's
        // accessible and defaults to false when `ReactDOMComponent` and
        // `ReactTextComponent` checks it in `mountComponent`.`
        this.renderToStaticMarkup = false;
        this.reactMountReady = CallbackQueue.getPooled(null);
        this.putListenerQueue = ReactPutListenerQueue.getPooled();
      }
      
      var Mixin = {
        /**
         * @see Transaction
         * @abstract
         * @final
         * @return {array<object>} List of operation wrap proceedures.
         *   TODO: convert to array<TransactionWrapper>
         */
        getTransactionWrappers: function() {
          return TRANSACTION_WRAPPERS;
        },
      
        /**
         * @return {object} The queue to collect `onDOMReady` callbacks with.
         */
        getReactMountReady: function() {
          return this.reactMountReady;
        },
      
        getPutListenerQueue: function() {
          return this.putListenerQueue;
        },
      
        /**
         * `PooledClass` looks for this, and will invoke this before allowing this
         * instance to be resused.
         */
        destructor: function() {
          CallbackQueue.release(this.reactMountReady);
          this.reactMountReady = null;
      
          ReactPutListenerQueue.release(this.putListenerQueue);
          this.putListenerQueue = null;
        }
      };
      
      
      mixInto(ReactReconcileTransaction, Transaction.Mixin);
      mixInto(ReactReconcileTransaction, Mixin);
      
      PooledClass.addPoolingTo(ReactReconcileTransaction);
      
      module.exports = ReactReconcileTransaction;
      
      },{"./CallbackQueue":5,"./PooledClass":26,"./ReactBrowserEventEmitter":29,"./ReactInputSelection":58,"./ReactPutListenerQueue":70,"./Transaction":92,"./mixInto":133}],72:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactRootIndex
       * @typechecks
       */
      
      "use strict";
      
      var ReactRootIndexInjection = {
        /**
         * @param {function} _createReactRootIndex
         */
        injectCreateReactRootIndex: function(_createReactRootIndex) {
          ReactRootIndex.createReactRootIndex = _createReactRootIndex;
        }
      };
      
      var ReactRootIndex = {
        createReactRootIndex: null,
        injection: ReactRootIndexInjection
      };
      
      module.exports = ReactRootIndex;
      
      },{}],73:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @typechecks static-only
       * @providesModule ReactServerRendering
       */
      "use strict";
      
      var ReactDescriptor = _dereq_("./ReactDescriptor");
      var ReactInstanceHandles = _dereq_("./ReactInstanceHandles");
      var ReactMarkupChecksum = _dereq_("./ReactMarkupChecksum");
      var ReactServerRenderingTransaction =
        _dereq_("./ReactServerRenderingTransaction");
      
      var instantiateReactComponent = _dereq_("./instantiateReactComponent");
      var invariant = _dereq_("./invariant");
      
      /**
       * @param {ReactComponent} component
       * @return {string} the HTML markup
       */
      function renderComponentToString(component) {
        ("production" !== "development" ? invariant(
          ReactDescriptor.isValidDescriptor(component),
          'renderComponentToString(): You must pass a valid ReactComponent.'
        ) : invariant(ReactDescriptor.isValidDescriptor(component)));
      
        ("production" !== "development" ? invariant(
          !(arguments.length === 2 && typeof arguments[1] === 'function'),
          'renderComponentToString(): This function became synchronous and now ' +
          'returns the generated markup. Please remove the second parameter.'
        ) : invariant(!(arguments.length === 2 && typeof arguments[1] === 'function')));
      
        var transaction;
        try {
          var id = ReactInstanceHandles.createReactRootID();
          transaction = ReactServerRenderingTransaction.getPooled(false);
      
          return transaction.perform(function() {
            var componentInstance = instantiateReactComponent(component);
            var markup = componentInstance.mountComponent(id, transaction, 0);
            return ReactMarkupChecksum.addChecksumToMarkup(markup);
          }, null);
        } finally {
          ReactServerRenderingTransaction.release(transaction);
        }
      }
      
      /**
       * @param {ReactComponent} component
       * @return {string} the HTML markup, without the extra React ID and checksum
      * (for generating static pages)
       */
      function renderComponentToStaticMarkup(component) {
        ("production" !== "development" ? invariant(
          ReactDescriptor.isValidDescriptor(component),
          'renderComponentToStaticMarkup(): You must pass a valid ReactComponent.'
        ) : invariant(ReactDescriptor.isValidDescriptor(component)));
      
        var transaction;
        try {
          var id = ReactInstanceHandles.createReactRootID();
          transaction = ReactServerRenderingTransaction.getPooled(true);
      
          return transaction.perform(function() {
            var componentInstance = instantiateReactComponent(component);
            return componentInstance.mountComponent(id, transaction, 0);
          }, null);
        } finally {
          ReactServerRenderingTransaction.release(transaction);
        }
      }
      
      module.exports = {
        renderComponentToString: renderComponentToString,
        renderComponentToStaticMarkup: renderComponentToStaticMarkup
      };
      
      },{"./ReactDescriptor":51,"./ReactInstanceHandles":59,"./ReactMarkupChecksum":60,"./ReactServerRenderingTransaction":74,"./instantiateReactComponent":119,"./invariant":120}],74:[function(_dereq_,module,exports){
      /**
       * Copyright 2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactServerRenderingTransaction
       * @typechecks
       */
      
      "use strict";
      
      var PooledClass = _dereq_("./PooledClass");
      var CallbackQueue = _dereq_("./CallbackQueue");
      var ReactPutListenerQueue = _dereq_("./ReactPutListenerQueue");
      var Transaction = _dereq_("./Transaction");
      
      var emptyFunction = _dereq_("./emptyFunction");
      var mixInto = _dereq_("./mixInto");
      
      /**
       * Provides a `CallbackQueue` queue for collecting `onDOMReady` callbacks
       * during the performing of the transaction.
       */
      var ON_DOM_READY_QUEUEING = {
        /**
         * Initializes the internal `onDOMReady` queue.
         */
        initialize: function() {
          this.reactMountReady.reset();
        },
      
        close: emptyFunction
      };
      
      var PUT_LISTENER_QUEUEING = {
        initialize: function() {
          this.putListenerQueue.reset();
        },
      
        close: emptyFunction
      };
      
      /**
       * Executed within the scope of the `Transaction` instance. Consider these as
       * being member methods, but with an implied ordering while being isolated from
       * each other.
       */
      var TRANSACTION_WRAPPERS = [
        PUT_LISTENER_QUEUEING,
        ON_DOM_READY_QUEUEING
      ];
      
      /**
       * @class ReactServerRenderingTransaction
       * @param {boolean} renderToStaticMarkup
       */
      function ReactServerRenderingTransaction(renderToStaticMarkup) {
        this.reinitializeTransaction();
        this.renderToStaticMarkup = renderToStaticMarkup;
        this.reactMountReady = CallbackQueue.getPooled(null);
        this.putListenerQueue = ReactPutListenerQueue.getPooled();
      }
      
      var Mixin = {
        /**
         * @see Transaction
         * @abstract
         * @final
         * @return {array} Empty list of operation wrap proceedures.
         */
        getTransactionWrappers: function() {
          return TRANSACTION_WRAPPERS;
        },
      
        /**
         * @return {object} The queue to collect `onDOMReady` callbacks with.
         */
        getReactMountReady: function() {
          return this.reactMountReady;
        },
      
        getPutListenerQueue: function() {
          return this.putListenerQueue;
        },
      
        /**
         * `PooledClass` looks for this, and will invoke this before allowing this
         * instance to be resused.
         */
        destructor: function() {
          CallbackQueue.release(this.reactMountReady);
          this.reactMountReady = null;
      
          ReactPutListenerQueue.release(this.putListenerQueue);
          this.putListenerQueue = null;
        }
      };
      
      
      mixInto(ReactServerRenderingTransaction, Transaction.Mixin);
      mixInto(ReactServerRenderingTransaction, Mixin);
      
      PooledClass.addPoolingTo(ReactServerRenderingTransaction);
      
      module.exports = ReactServerRenderingTransaction;
      
      },{"./CallbackQueue":5,"./PooledClass":26,"./ReactPutListenerQueue":70,"./Transaction":92,"./emptyFunction":102,"./mixInto":133}],75:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactTextComponent
       * @typechecks static-only
       */
      
      "use strict";
      
      var DOMPropertyOperations = _dereq_("./DOMPropertyOperations");
      var ReactBrowserComponentMixin = _dereq_("./ReactBrowserComponentMixin");
      var ReactComponent = _dereq_("./ReactComponent");
      var ReactDescriptor = _dereq_("./ReactDescriptor");
      
      var escapeTextForBrowser = _dereq_("./escapeTextForBrowser");
      var mixInto = _dereq_("./mixInto");
      
      /**
       * Text nodes violate a couple assumptions that React makes about components:
       *
       *  - When mounting text into the DOM, adjacent text nodes are merged.
       *  - Text nodes cannot be assigned a React root ID.
       *
       * This component is used to wrap strings in elements so that they can undergo
       * the same reconciliation that is applied to elements.
       *
       * TODO: Investigate representing React components in the DOM with text nodes.
       *
       * @class ReactTextComponent
       * @extends ReactComponent
       * @internal
       */
      var ReactTextComponent = function(descriptor) {
        this.construct(descriptor);
      };
      
      mixInto(ReactTextComponent, ReactComponent.Mixin);
      mixInto(ReactTextComponent, ReactBrowserComponentMixin);
      mixInto(ReactTextComponent, {
      
        /**
         * Creates the markup for this text node. This node is not intended to have
         * any features besides containing text content.
         *
         * @param {string} rootID DOM ID of the root node.
         * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
         * @param {number} mountDepth number of components in the owner hierarchy
         * @return {string} Markup for this text node.
         * @internal
         */
        mountComponent: function(rootID, transaction, mountDepth) {
          ReactComponent.Mixin.mountComponent.call(
            this,
            rootID,
            transaction,
            mountDepth
          );
      
          var escapedText = escapeTextForBrowser(this.props);
      
          if (transaction.renderToStaticMarkup) {
            // Normally we'd wrap this in a `span` for the reasons stated above, but
            // since this is a situation where React won't take over (static pages),
            // we can simply return the text as it is.
            return escapedText;
          }
      
          return (
            '<span ' + DOMPropertyOperations.createMarkupForID(rootID) + '>' +
              escapedText +
            '</span>'
          );
        },
      
        /**
         * Updates this component by updating the text content.
         *
         * @param {object} nextComponent Contains the next text content.
         * @param {ReactReconcileTransaction} transaction
         * @internal
         */
        receiveComponent: function(nextComponent, transaction) {
          var nextProps = nextComponent.props;
          if (nextProps !== this.props) {
            this.props = nextProps;
            ReactComponent.BackendIDOperations.updateTextContentByID(
              this._rootNodeID,
              nextProps
            );
          }
        }
      
      });
      
      module.exports = ReactDescriptor.createFactory(ReactTextComponent);
      
      },{"./DOMPropertyOperations":11,"./ReactBrowserComponentMixin":28,"./ReactComponent":31,"./ReactDescriptor":51,"./escapeTextForBrowser":104,"./mixInto":133}],76:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ReactUpdates
       */
      
      "use strict";
      
      var CallbackQueue = _dereq_("./CallbackQueue");
      var PooledClass = _dereq_("./PooledClass");
      var ReactCurrentOwner = _dereq_("./ReactCurrentOwner");
      var ReactPerf = _dereq_("./ReactPerf");
      var Transaction = _dereq_("./Transaction");
      
      var invariant = _dereq_("./invariant");
      var mixInto = _dereq_("./mixInto");
      var warning = _dereq_("./warning");
      
      var dirtyComponents = [];
      
      var batchingStrategy = null;
      
      function ensureInjected() {
        ("production" !== "development" ? invariant(
          ReactUpdates.ReactReconcileTransaction && batchingStrategy,
          'ReactUpdates: must inject a reconcile transaction class and batching ' +
          'strategy'
        ) : invariant(ReactUpdates.ReactReconcileTransaction && batchingStrategy));
      }
      
      var NESTED_UPDATES = {
        initialize: function() {
          this.dirtyComponentsLength = dirtyComponents.length;
        },
        close: function() {
          if (this.dirtyComponentsLength !== dirtyComponents.length) {
            // Additional updates were enqueued by componentDidUpdate handlers or
            // similar; before our own UPDATE_QUEUEING wrapper closes, we want to run
            // these new updates so that if A's componentDidUpdate calls setState on
            // B, B will update before the callback A's updater provided when calling
            // setState.
            dirtyComponents.splice(0, this.dirtyComponentsLength);
            flushBatchedUpdates();
          } else {
            dirtyComponents.length = 0;
          }
        }
      };
      
      var UPDATE_QUEUEING = {
        initialize: function() {
          this.callbackQueue.reset();
        },
        close: function() {
          this.callbackQueue.notifyAll();
        }
      };
      
      var TRANSACTION_WRAPPERS = [NESTED_UPDATES, UPDATE_QUEUEING];
      
      function ReactUpdatesFlushTransaction() {
        this.reinitializeTransaction();
        this.dirtyComponentsLength = null;
        this.callbackQueue = CallbackQueue.getPooled(null);
        this.reconcileTransaction =
          ReactUpdates.ReactReconcileTransaction.getPooled();
      }
      
      mixInto(ReactUpdatesFlushTransaction, Transaction.Mixin);
      mixInto(ReactUpdatesFlushTransaction, {
        getTransactionWrappers: function() {
          return TRANSACTION_WRAPPERS;
        },
      
        destructor: function() {
          this.dirtyComponentsLength = null;
          CallbackQueue.release(this.callbackQueue);
          this.callbackQueue = null;
          ReactUpdates.ReactReconcileTransaction.release(this.reconcileTransaction);
          this.reconcileTransaction = null;
        },
      
        perform: function(method, scope, a) {
          // Essentially calls `this.reconcileTransaction.perform(method, scope, a)`
          // with this transaction's wrappers around it.
          return Transaction.Mixin.perform.call(
            this,
            this.reconcileTransaction.perform,
            this.reconcileTransaction,
            method,
            scope,
            a
          );
        }
      });
      
      PooledClass.addPoolingTo(ReactUpdatesFlushTransaction);
      
      function batchedUpdates(callback, a, b) {
        ensureInjected();
        batchingStrategy.batchedUpdates(callback, a, b);
      }
      
      /**
       * Array comparator for ReactComponents by owner depth
       *
       * @param {ReactComponent} c1 first component you're comparing
       * @param {ReactComponent} c2 second component you're comparing
       * @return {number} Return value usable by Array.prototype.sort().
       */
      function mountDepthComparator(c1, c2) {
        return c1._mountDepth - c2._mountDepth;
      }
      
      function runBatchedUpdates(transaction) {
        var len = transaction.dirtyComponentsLength;
        ("production" !== "development" ? invariant(
          len === dirtyComponents.length,
          'Expected flush transaction\'s stored dirty-components length (%s) to ' +
          'match dirty-components array length (%s).',
          len,
          dirtyComponents.length
        ) : invariant(len === dirtyComponents.length));
      
        // Since reconciling a component higher in the owner hierarchy usually (not
        // always -- see shouldComponentUpdate()) will reconcile children, reconcile
        // them before their children by sorting the array.
        dirtyComponents.sort(mountDepthComparator);
      
        for (var i = 0; i < len; i++) {
          // If a component is unmounted before pending changes apply, ignore them
          // TODO: Queue unmounts in the same list to avoid this happening at all
          var component = dirtyComponents[i];
          if (component.isMounted()) {
            // If performUpdateIfNecessary happens to enqueue any new updates, we
            // shouldn't execute the callbacks until the next render happens, so
            // stash the callbacks first
            var callbacks = component._pendingCallbacks;
            component._pendingCallbacks = null;
            component.performUpdateIfNecessary(transaction.reconcileTransaction);
      
            if (callbacks) {
              for (var j = 0; j < callbacks.length; j++) {
                transaction.callbackQueue.enqueue(
                  callbacks[j],
                  component
                );
              }
            }
          }
        }
      }
      
      var flushBatchedUpdates = ReactPerf.measure(
        'ReactUpdates',
        'flushBatchedUpdates',
        function() {
          // ReactUpdatesFlushTransaction's wrappers will clear the dirtyComponents
          // array and perform any updates enqueued by mount-ready handlers (i.e.,
          // componentDidUpdate) but we need to check here too in order to catch
          // updates enqueued by setState callbacks.
          while (dirtyComponents.length) {
            var transaction = ReactUpdatesFlushTransaction.getPooled();
            transaction.perform(runBatchedUpdates, null, transaction);
            ReactUpdatesFlushTransaction.release(transaction);
          }
        }
      );
      
      /**
       * Mark a component as needing a rerender, adding an optional callback to a
       * list of functions which will be executed once the rerender occurs.
       */
      function enqueueUpdate(component, callback) {
        ("production" !== "development" ? invariant(
          !callback || typeof callback === "function",
          'enqueueUpdate(...): You called `setProps`, `replaceProps`, ' +
          '`setState`, `replaceState`, or `forceUpdate` with a callback that ' +
          'isn\'t callable.'
        ) : invariant(!callback || typeof callback === "function"));
        ensureInjected();
      
        // Various parts of our code (such as ReactCompositeComponent's
        // _renderValidatedComponent) assume that calls to render aren't nested;
        // verify that that's the case. (This is called by each top-level update
        // function, like setProps, setState, forceUpdate, etc.; creation and
        // destruction of top-level components is guarded in ReactMount.)
        ("production" !== "development" ? warning(
          ReactCurrentOwner.current == null,
          'enqueueUpdate(): Render methods should be a pure function of props ' +
          'and state; triggering nested component updates from render is not ' +
          'allowed. If necessary, trigger nested updates in ' +
          'componentDidUpdate.'
        ) : null);
      
        if (!batchingStrategy.isBatchingUpdates) {
          batchingStrategy.batchedUpdates(enqueueUpdate, component, callback);
          return;
        }
      
        dirtyComponents.push(component);
      
        if (callback) {
          if (component._pendingCallbacks) {
            component._pendingCallbacks.push(callback);
          } else {
            component._pendingCallbacks = [callback];
          }
        }
      }
      
      var ReactUpdatesInjection = {
        injectReconcileTransaction: function(ReconcileTransaction) {
          ("production" !== "development" ? invariant(
            ReconcileTransaction,
            'ReactUpdates: must provide a reconcile transaction class'
          ) : invariant(ReconcileTransaction));
          ReactUpdates.ReactReconcileTransaction = ReconcileTransaction;
        },
      
        injectBatchingStrategy: function(_batchingStrategy) {
          ("production" !== "development" ? invariant(
            _batchingStrategy,
            'ReactUpdates: must provide a batching strategy'
          ) : invariant(_batchingStrategy));
          ("production" !== "development" ? invariant(
            typeof _batchingStrategy.batchedUpdates === 'function',
            'ReactUpdates: must provide a batchedUpdates() function'
          ) : invariant(typeof _batchingStrategy.batchedUpdates === 'function'));
          ("production" !== "development" ? invariant(
            typeof _batchingStrategy.isBatchingUpdates === 'boolean',
            'ReactUpdates: must provide an isBatchingUpdates boolean attribute'
          ) : invariant(typeof _batchingStrategy.isBatchingUpdates === 'boolean'));
          batchingStrategy = _batchingStrategy;
        }
      };
      
      var ReactUpdates = {
        /**
         * React references `ReactReconcileTransaction` using this property in order
         * to allow dependency injection.
         *
         * @internal
         */
        ReactReconcileTransaction: null,
      
        batchedUpdates: batchedUpdates,
        enqueueUpdate: enqueueUpdate,
        flushBatchedUpdates: flushBatchedUpdates,
        injection: ReactUpdatesInjection
      };
      
      module.exports = ReactUpdates;
      
      },{"./CallbackQueue":5,"./PooledClass":26,"./ReactCurrentOwner":35,"./ReactPerf":65,"./Transaction":92,"./invariant":120,"./mixInto":133,"./warning":143}],77:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SVGDOMPropertyConfig
       */
      
      /*jslint bitwise: true*/
      
      "use strict";
      
      var DOMProperty = _dereq_("./DOMProperty");
      
      var MUST_USE_ATTRIBUTE = DOMProperty.injection.MUST_USE_ATTRIBUTE;
      
      var SVGDOMPropertyConfig = {
        Properties: {
          cx: MUST_USE_ATTRIBUTE,
          cy: MUST_USE_ATTRIBUTE,
          d: MUST_USE_ATTRIBUTE,
          dx: MUST_USE_ATTRIBUTE,
          dy: MUST_USE_ATTRIBUTE,
          fill: MUST_USE_ATTRIBUTE,
          fillOpacity: MUST_USE_ATTRIBUTE,
          fontFamily: MUST_USE_ATTRIBUTE,
          fontSize: MUST_USE_ATTRIBUTE,
          fx: MUST_USE_ATTRIBUTE,
          fy: MUST_USE_ATTRIBUTE,
          gradientTransform: MUST_USE_ATTRIBUTE,
          gradientUnits: MUST_USE_ATTRIBUTE,
          markerEnd: MUST_USE_ATTRIBUTE,
          markerMid: MUST_USE_ATTRIBUTE,
          markerStart: MUST_USE_ATTRIBUTE,
          offset: MUST_USE_ATTRIBUTE,
          opacity: MUST_USE_ATTRIBUTE,
          patternContentUnits: MUST_USE_ATTRIBUTE,
          patternUnits: MUST_USE_ATTRIBUTE,
          points: MUST_USE_ATTRIBUTE,
          preserveAspectRatio: MUST_USE_ATTRIBUTE,
          r: MUST_USE_ATTRIBUTE,
          rx: MUST_USE_ATTRIBUTE,
          ry: MUST_USE_ATTRIBUTE,
          spreadMethod: MUST_USE_ATTRIBUTE,
          stopColor: MUST_USE_ATTRIBUTE,
          stopOpacity: MUST_USE_ATTRIBUTE,
          stroke: MUST_USE_ATTRIBUTE,
          strokeDasharray: MUST_USE_ATTRIBUTE,
          strokeLinecap: MUST_USE_ATTRIBUTE,
          strokeOpacity: MUST_USE_ATTRIBUTE,
          strokeWidth: MUST_USE_ATTRIBUTE,
          textAnchor: MUST_USE_ATTRIBUTE,
          transform: MUST_USE_ATTRIBUTE,
          version: MUST_USE_ATTRIBUTE,
          viewBox: MUST_USE_ATTRIBUTE,
          x1: MUST_USE_ATTRIBUTE,
          x2: MUST_USE_ATTRIBUTE,
          x: MUST_USE_ATTRIBUTE,
          y1: MUST_USE_ATTRIBUTE,
          y2: MUST_USE_ATTRIBUTE,
          y: MUST_USE_ATTRIBUTE
        },
        DOMAttributeNames: {
          fillOpacity: 'fill-opacity',
          fontFamily: 'font-family',
          fontSize: 'font-size',
          gradientTransform: 'gradientTransform',
          gradientUnits: 'gradientUnits',
          markerEnd: 'marker-end',
          markerMid: 'marker-mid',
          markerStart: 'marker-start',
          patternContentUnits: 'patternContentUnits',
          patternUnits: 'patternUnits',
          preserveAspectRatio: 'preserveAspectRatio',
          spreadMethod: 'spreadMethod',
          stopColor: 'stop-color',
          stopOpacity: 'stop-opacity',
          strokeDasharray: 'stroke-dasharray',
          strokeLinecap: 'stroke-linecap',
          strokeOpacity: 'stroke-opacity',
          strokeWidth: 'stroke-width',
          textAnchor: 'text-anchor',
          viewBox: 'viewBox'
        }
      };
      
      module.exports = SVGDOMPropertyConfig;
      
      },{"./DOMProperty":10}],78:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SelectEventPlugin
       */
      
      "use strict";
      
      var EventConstants = _dereq_("./EventConstants");
      var EventPropagators = _dereq_("./EventPropagators");
      var ReactInputSelection = _dereq_("./ReactInputSelection");
      var SyntheticEvent = _dereq_("./SyntheticEvent");
      
      var getActiveElement = _dereq_("./getActiveElement");
      var isTextInputElement = _dereq_("./isTextInputElement");
      var keyOf = _dereq_("./keyOf");
      var shallowEqual = _dereq_("./shallowEqual");
      
      var topLevelTypes = EventConstants.topLevelTypes;
      
      var eventTypes = {
        select: {
          phasedRegistrationNames: {
            bubbled: keyOf({onSelect: null}),
            captured: keyOf({onSelectCapture: null})
          },
          dependencies: [
            topLevelTypes.topBlur,
            topLevelTypes.topContextMenu,
            topLevelTypes.topFocus,
            topLevelTypes.topKeyDown,
            topLevelTypes.topMouseDown,
            topLevelTypes.topMouseUp,
            topLevelTypes.topSelectionChange
          ]
        }
      };
      
      var activeElement = null;
      var activeElementID = null;
      var lastSelection = null;
      var mouseDown = false;
      
      /**
       * Get an object which is a unique representation of the current selection.
       *
       * The return value will not be consistent across nodes or browsers, but
       * two identical selections on the same node will return identical objects.
       *
       * @param {DOMElement} node
       * @param {object}
       */
      function getSelection(node) {
        if ('selectionStart' in node &&
            ReactInputSelection.hasSelectionCapabilities(node)) {
          return {
            start: node.selectionStart,
            end: node.selectionEnd
          };
        } else if (document.selection) {
          var range = document.selection.createRange();
          return {
            parentElement: range.parentElement(),
            text: range.text,
            top: range.boundingTop,
            left: range.boundingLeft
          };
        } else {
          var selection = window.getSelection();
          return {
            anchorNode: selection.anchorNode,
            anchorOffset: selection.anchorOffset,
            focusNode: selection.focusNode,
            focusOffset: selection.focusOffset
          };
        }
      }
      
      /**
       * Poll selection to see whether it's changed.
       *
       * @param {object} nativeEvent
       * @return {?SyntheticEvent}
       */
      function constructSelectEvent(nativeEvent) {
        // Ensure we have the right element, and that the user is not dragging a
        // selection (this matches native `select` event behavior). In HTML5, select
        // fires only on input and textarea thus if there's no focused element we
        // won't dispatch.
        if (mouseDown ||
            activeElement == null ||
            activeElement != getActiveElement()) {
          return;
        }
      
        // Only fire when selection has actually changed.
        var currentSelection = getSelection(activeElement);
        if (!lastSelection || !shallowEqual(lastSelection, currentSelection)) {
          lastSelection = currentSelection;
      
          var syntheticEvent = SyntheticEvent.getPooled(
            eventTypes.select,
            activeElementID,
            nativeEvent
          );
      
          syntheticEvent.type = 'select';
          syntheticEvent.target = activeElement;
      
          EventPropagators.accumulateTwoPhaseDispatches(syntheticEvent);
      
          return syntheticEvent;
        }
      }
      
      /**
       * This plugin creates an `onSelect` event that normalizes select events
       * across form elements.
       *
       * Supported elements are:
       * - input (see `isTextInputElement`)
       * - textarea
       * - contentEditable
       *
       * This differs from native browser implementations in the following ways:
       * - Fires on contentEditable fields as well as inputs.
       * - Fires for collapsed selection.
       * - Fires after user input.
       */
      var SelectEventPlugin = {
      
        eventTypes: eventTypes,
      
        /**
         * @param {string} topLevelType Record from `EventConstants`.
         * @param {DOMEventTarget} topLevelTarget The listening component root node.
         * @param {string} topLevelTargetID ID of `topLevelTarget`.
         * @param {object} nativeEvent Native browser event.
         * @return {*} An accumulation of synthetic events.
         * @see {EventPluginHub.extractEvents}
         */
        extractEvents: function(
            topLevelType,
            topLevelTarget,
            topLevelTargetID,
            nativeEvent) {
      
          switch (topLevelType) {
            // Track the input node that has focus.
            case topLevelTypes.topFocus:
              if (isTextInputElement(topLevelTarget) ||
                  topLevelTarget.contentEditable === 'true') {
                activeElement = topLevelTarget;
                activeElementID = topLevelTargetID;
                lastSelection = null;
              }
              break;
            case topLevelTypes.topBlur:
              activeElement = null;
              activeElementID = null;
              lastSelection = null;
              break;
      
            // Don't fire the event while the user is dragging. This matches the
            // semantics of the native select event.
            case topLevelTypes.topMouseDown:
              mouseDown = true;
              break;
            case topLevelTypes.topContextMenu:
            case topLevelTypes.topMouseUp:
              mouseDown = false;
              return constructSelectEvent(nativeEvent);
      
            // Chrome and IE fire non-standard event when selection is changed (and
            // sometimes when it hasn't).
            // Firefox doesn't support selectionchange, so check selection status
            // after each key entry. The selection changes after keydown and before
            // keyup, but we check on keydown as well in the case of holding down a
            // key, when multiple keydown events are fired but only one keyup is.
            case topLevelTypes.topSelectionChange:
            case topLevelTypes.topKeyDown:
            case topLevelTypes.topKeyUp:
              return constructSelectEvent(nativeEvent);
          }
        }
      };
      
      module.exports = SelectEventPlugin;
      
      },{"./EventConstants":15,"./EventPropagators":20,"./ReactInputSelection":58,"./SyntheticEvent":84,"./getActiveElement":108,"./isTextInputElement":123,"./keyOf":127,"./shallowEqual":139}],79:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ServerReactRootIndex
       * @typechecks
       */
      
      "use strict";
      
      /**
       * Size of the reactRoot ID space. We generate random numbers for React root
       * IDs and if there's a collision the events and DOM update system will
       * get confused. In the future we need a way to generate GUIDs but for
       * now this will work on a smaller scale.
       */
      var GLOBAL_MOUNT_POINT_MAX = Math.pow(2, 53);
      
      var ServerReactRootIndex = {
        createReactRootIndex: function() {
          return Math.ceil(Math.random() * GLOBAL_MOUNT_POINT_MAX);
        }
      };
      
      module.exports = ServerReactRootIndex;
      
      },{}],80:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SimpleEventPlugin
       */
      
      "use strict";
      
      var EventConstants = _dereq_("./EventConstants");
      var EventPluginUtils = _dereq_("./EventPluginUtils");
      var EventPropagators = _dereq_("./EventPropagators");
      var SyntheticClipboardEvent = _dereq_("./SyntheticClipboardEvent");
      var SyntheticEvent = _dereq_("./SyntheticEvent");
      var SyntheticFocusEvent = _dereq_("./SyntheticFocusEvent");
      var SyntheticKeyboardEvent = _dereq_("./SyntheticKeyboardEvent");
      var SyntheticMouseEvent = _dereq_("./SyntheticMouseEvent");
      var SyntheticDragEvent = _dereq_("./SyntheticDragEvent");
      var SyntheticTouchEvent = _dereq_("./SyntheticTouchEvent");
      var SyntheticUIEvent = _dereq_("./SyntheticUIEvent");
      var SyntheticWheelEvent = _dereq_("./SyntheticWheelEvent");
      
      var invariant = _dereq_("./invariant");
      var keyOf = _dereq_("./keyOf");
      
      var topLevelTypes = EventConstants.topLevelTypes;
      
      var eventTypes = {
        blur: {
          phasedRegistrationNames: {
            bubbled: keyOf({onBlur: true}),
            captured: keyOf({onBlurCapture: true})
          }
        },
        click: {
          phasedRegistrationNames: {
            bubbled: keyOf({onClick: true}),
            captured: keyOf({onClickCapture: true})
          }
        },
        contextMenu: {
          phasedRegistrationNames: {
            bubbled: keyOf({onContextMenu: true}),
            captured: keyOf({onContextMenuCapture: true})
          }
        },
        copy: {
          phasedRegistrationNames: {
            bubbled: keyOf({onCopy: true}),
            captured: keyOf({onCopyCapture: true})
          }
        },
        cut: {
          phasedRegistrationNames: {
            bubbled: keyOf({onCut: true}),
            captured: keyOf({onCutCapture: true})
          }
        },
        doubleClick: {
          phasedRegistrationNames: {
            bubbled: keyOf({onDoubleClick: true}),
            captured: keyOf({onDoubleClickCapture: true})
          }
        },
        drag: {
          phasedRegistrationNames: {
            bubbled: keyOf({onDrag: true}),
            captured: keyOf({onDragCapture: true})
          }
        },
        dragEnd: {
          phasedRegistrationNames: {
            bubbled: keyOf({onDragEnd: true}),
            captured: keyOf({onDragEndCapture: true})
          }
        },
        dragEnter: {
          phasedRegistrationNames: {
            bubbled: keyOf({onDragEnter: true}),
            captured: keyOf({onDragEnterCapture: true})
          }
        },
        dragExit: {
          phasedRegistrationNames: {
            bubbled: keyOf({onDragExit: true}),
            captured: keyOf({onDragExitCapture: true})
          }
        },
        dragLeave: {
          phasedRegistrationNames: {
            bubbled: keyOf({onDragLeave: true}),
            captured: keyOf({onDragLeaveCapture: true})
          }
        },
        dragOver: {
          phasedRegistrationNames: {
            bubbled: keyOf({onDragOver: true}),
            captured: keyOf({onDragOverCapture: true})
          }
        },
        dragStart: {
          phasedRegistrationNames: {
            bubbled: keyOf({onDragStart: true}),
            captured: keyOf({onDragStartCapture: true})
          }
        },
        drop: {
          phasedRegistrationNames: {
            bubbled: keyOf({onDrop: true}),
            captured: keyOf({onDropCapture: true})
          }
        },
        focus: {
          phasedRegistrationNames: {
            bubbled: keyOf({onFocus: true}),
            captured: keyOf({onFocusCapture: true})
          }
        },
        input: {
          phasedRegistrationNames: {
            bubbled: keyOf({onInput: true}),
            captured: keyOf({onInputCapture: true})
          }
        },
        keyDown: {
          phasedRegistrationNames: {
            bubbled: keyOf({onKeyDown: true}),
            captured: keyOf({onKeyDownCapture: true})
          }
        },
        keyPress: {
          phasedRegistrationNames: {
            bubbled: keyOf({onKeyPress: true}),
            captured: keyOf({onKeyPressCapture: true})
          }
        },
        keyUp: {
          phasedRegistrationNames: {
            bubbled: keyOf({onKeyUp: true}),
            captured: keyOf({onKeyUpCapture: true})
          }
        },
        load: {
          phasedRegistrationNames: {
            bubbled: keyOf({onLoad: true}),
            captured: keyOf({onLoadCapture: true})
          }
        },
        error: {
          phasedRegistrationNames: {
            bubbled: keyOf({onError: true}),
            captured: keyOf({onErrorCapture: true})
          }
        },
        // Note: We do not allow listening to mouseOver events. Instead, use the
        // onMouseEnter/onMouseLeave created by `EnterLeaveEventPlugin`.
        mouseDown: {
          phasedRegistrationNames: {
            bubbled: keyOf({onMouseDown: true}),
            captured: keyOf({onMouseDownCapture: true})
          }
        },
        mouseMove: {
          phasedRegistrationNames: {
            bubbled: keyOf({onMouseMove: true}),
            captured: keyOf({onMouseMoveCapture: true})
          }
        },
        mouseOut: {
          phasedRegistrationNames: {
            bubbled: keyOf({onMouseOut: true}),
            captured: keyOf({onMouseOutCapture: true})
          }
        },
        mouseOver: {
          phasedRegistrationNames: {
            bubbled: keyOf({onMouseOver: true}),
            captured: keyOf({onMouseOverCapture: true})
          }
        },
        mouseUp: {
          phasedRegistrationNames: {
            bubbled: keyOf({onMouseUp: true}),
            captured: keyOf({onMouseUpCapture: true})
          }
        },
        paste: {
          phasedRegistrationNames: {
            bubbled: keyOf({onPaste: true}),
            captured: keyOf({onPasteCapture: true})
          }
        },
        reset: {
          phasedRegistrationNames: {
            bubbled: keyOf({onReset: true}),
            captured: keyOf({onResetCapture: true})
          }
        },
        scroll: {
          phasedRegistrationNames: {
            bubbled: keyOf({onScroll: true}),
            captured: keyOf({onScrollCapture: true})
          }
        },
        submit: {
          phasedRegistrationNames: {
            bubbled: keyOf({onSubmit: true}),
            captured: keyOf({onSubmitCapture: true})
          }
        },
        touchCancel: {
          phasedRegistrationNames: {
            bubbled: keyOf({onTouchCancel: true}),
            captured: keyOf({onTouchCancelCapture: true})
          }
        },
        touchEnd: {
          phasedRegistrationNames: {
            bubbled: keyOf({onTouchEnd: true}),
            captured: keyOf({onTouchEndCapture: true})
          }
        },
        touchMove: {
          phasedRegistrationNames: {
            bubbled: keyOf({onTouchMove: true}),
            captured: keyOf({onTouchMoveCapture: true})
          }
        },
        touchStart: {
          phasedRegistrationNames: {
            bubbled: keyOf({onTouchStart: true}),
            captured: keyOf({onTouchStartCapture: true})
          }
        },
        wheel: {
          phasedRegistrationNames: {
            bubbled: keyOf({onWheel: true}),
            captured: keyOf({onWheelCapture: true})
          }
        }
      };
      
      var topLevelEventsToDispatchConfig = {
        topBlur:        eventTypes.blur,
        topClick:       eventTypes.click,
        topContextMenu: eventTypes.contextMenu,
        topCopy:        eventTypes.copy,
        topCut:         eventTypes.cut,
        topDoubleClick: eventTypes.doubleClick,
        topDrag:        eventTypes.drag,
        topDragEnd:     eventTypes.dragEnd,
        topDragEnter:   eventTypes.dragEnter,
        topDragExit:    eventTypes.dragExit,
        topDragLeave:   eventTypes.dragLeave,
        topDragOver:    eventTypes.dragOver,
        topDragStart:   eventTypes.dragStart,
        topDrop:        eventTypes.drop,
        topError:       eventTypes.error,
        topFocus:       eventTypes.focus,
        topInput:       eventTypes.input,
        topKeyDown:     eventTypes.keyDown,
        topKeyPress:    eventTypes.keyPress,
        topKeyUp:       eventTypes.keyUp,
        topLoad:        eventTypes.load,
        topMouseDown:   eventTypes.mouseDown,
        topMouseMove:   eventTypes.mouseMove,
        topMouseOut:    eventTypes.mouseOut,
        topMouseOver:   eventTypes.mouseOver,
        topMouseUp:     eventTypes.mouseUp,
        topPaste:       eventTypes.paste,
        topReset:       eventTypes.reset,
        topScroll:      eventTypes.scroll,
        topSubmit:      eventTypes.submit,
        topTouchCancel: eventTypes.touchCancel,
        topTouchEnd:    eventTypes.touchEnd,
        topTouchMove:   eventTypes.touchMove,
        topTouchStart:  eventTypes.touchStart,
        topWheel:       eventTypes.wheel
      };
      
      for (var topLevelType in topLevelEventsToDispatchConfig) {
        topLevelEventsToDispatchConfig[topLevelType].dependencies = [topLevelType];
      }
      
      var SimpleEventPlugin = {
      
        eventTypes: eventTypes,
      
        /**
         * Same as the default implementation, except cancels the event when return
         * value is false.
         *
         * @param {object} Event to be dispatched.
         * @param {function} Application-level callback.
         * @param {string} domID DOM ID to pass to the callback.
         */
        executeDispatch: function(event, listener, domID) {
          var returnValue = EventPluginUtils.executeDispatch(event, listener, domID);
          if (returnValue === false) {
            event.stopPropagation();
            event.preventDefault();
          }
        },
      
        /**
         * @param {string} topLevelType Record from `EventConstants`.
         * @param {DOMEventTarget} topLevelTarget The listening component root node.
         * @param {string} topLevelTargetID ID of `topLevelTarget`.
         * @param {object} nativeEvent Native browser event.
         * @return {*} An accumulation of synthetic events.
         * @see {EventPluginHub.extractEvents}
         */
        extractEvents: function(
            topLevelType,
            topLevelTarget,
            topLevelTargetID,
            nativeEvent) {
          var dispatchConfig = topLevelEventsToDispatchConfig[topLevelType];
          if (!dispatchConfig) {
            return null;
          }
          var EventConstructor;
          switch (topLevelType) {
            case topLevelTypes.topInput:
            case topLevelTypes.topLoad:
            case topLevelTypes.topError:
            case topLevelTypes.topReset:
            case topLevelTypes.topSubmit:
              // HTML Events
              // @see http://www.w3.org/TR/html5/index.html#events-0
              EventConstructor = SyntheticEvent;
              break;
            case topLevelTypes.topKeyPress:
              // FireFox creates a keypress event for function keys too. This removes
              // the unwanted keypress events.
              if (nativeEvent.charCode === 0) {
                return null;
              }
              /* falls through */
            case topLevelTypes.topKeyDown:
            case topLevelTypes.topKeyUp:
              EventConstructor = SyntheticKeyboardEvent;
              break;
            case topLevelTypes.topBlur:
            case topLevelTypes.topFocus:
              EventConstructor = SyntheticFocusEvent;
              break;
            case topLevelTypes.topClick:
              // Firefox creates a click event on right mouse clicks. This removes the
              // unwanted click events.
              if (nativeEvent.button === 2) {
                return null;
              }
              /* falls through */
            case topLevelTypes.topContextMenu:
            case topLevelTypes.topDoubleClick:
            case topLevelTypes.topMouseDown:
            case topLevelTypes.topMouseMove:
            case topLevelTypes.topMouseOut:
            case topLevelTypes.topMouseOver:
            case topLevelTypes.topMouseUp:
              EventConstructor = SyntheticMouseEvent;
              break;
            case topLevelTypes.topDrag:
            case topLevelTypes.topDragEnd:
            case topLevelTypes.topDragEnter:
            case topLevelTypes.topDragExit:
            case topLevelTypes.topDragLeave:
            case topLevelTypes.topDragOver:
            case topLevelTypes.topDragStart:
            case topLevelTypes.topDrop:
              EventConstructor = SyntheticDragEvent;
              break;
            case topLevelTypes.topTouchCancel:
            case topLevelTypes.topTouchEnd:
            case topLevelTypes.topTouchMove:
            case topLevelTypes.topTouchStart:
              EventConstructor = SyntheticTouchEvent;
              break;
            case topLevelTypes.topScroll:
              EventConstructor = SyntheticUIEvent;
              break;
            case topLevelTypes.topWheel:
              EventConstructor = SyntheticWheelEvent;
              break;
            case topLevelTypes.topCopy:
            case topLevelTypes.topCut:
            case topLevelTypes.topPaste:
              EventConstructor = SyntheticClipboardEvent;
              break;
          }
          ("production" !== "development" ? invariant(
            EventConstructor,
            'SimpleEventPlugin: Unhandled event type, `%s`.',
            topLevelType
          ) : invariant(EventConstructor));
          var event = EventConstructor.getPooled(
            dispatchConfig,
            topLevelTargetID,
            nativeEvent
          );
          EventPropagators.accumulateTwoPhaseDispatches(event);
          return event;
        }
      
      };
      
      module.exports = SimpleEventPlugin;
      
      },{"./EventConstants":15,"./EventPluginUtils":19,"./EventPropagators":20,"./SyntheticClipboardEvent":81,"./SyntheticDragEvent":83,"./SyntheticEvent":84,"./SyntheticFocusEvent":85,"./SyntheticKeyboardEvent":87,"./SyntheticMouseEvent":88,"./SyntheticTouchEvent":89,"./SyntheticUIEvent":90,"./SyntheticWheelEvent":91,"./invariant":120,"./keyOf":127}],81:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SyntheticClipboardEvent
       * @typechecks static-only
       */
      
      "use strict";
      
      var SyntheticEvent = _dereq_("./SyntheticEvent");
      
      /**
       * @interface Event
       * @see http://www.w3.org/TR/clipboard-apis/
       */
      var ClipboardEventInterface = {
        clipboardData: function(event) {
          return (
            'clipboardData' in event ?
              event.clipboardData :
              window.clipboardData
          );
        }
      };
      
      /**
       * @param {object} dispatchConfig Configuration used to dispatch this event.
       * @param {string} dispatchMarker Marker identifying the event target.
       * @param {object} nativeEvent Native browser event.
       * @extends {SyntheticUIEvent}
       */
      function SyntheticClipboardEvent(dispatchConfig, dispatchMarker, nativeEvent) {
        SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
      }
      
      SyntheticEvent.augmentClass(SyntheticClipboardEvent, ClipboardEventInterface);
      
      module.exports = SyntheticClipboardEvent;
      
      
      },{"./SyntheticEvent":84}],82:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SyntheticCompositionEvent
       * @typechecks static-only
       */
      
      "use strict";
      
      var SyntheticEvent = _dereq_("./SyntheticEvent");
      
      /**
       * @interface Event
       * @see http://www.w3.org/TR/DOM-Level-3-Events/#events-compositionevents
       */
      var CompositionEventInterface = {
        data: null
      };
      
      /**
       * @param {object} dispatchConfig Configuration used to dispatch this event.
       * @param {string} dispatchMarker Marker identifying the event target.
       * @param {object} nativeEvent Native browser event.
       * @extends {SyntheticUIEvent}
       */
      function SyntheticCompositionEvent(
        dispatchConfig,
        dispatchMarker,
        nativeEvent) {
        SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
      }
      
      SyntheticEvent.augmentClass(
        SyntheticCompositionEvent,
        CompositionEventInterface
      );
      
      module.exports = SyntheticCompositionEvent;
      
      
      },{"./SyntheticEvent":84}],83:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SyntheticDragEvent
       * @typechecks static-only
       */
      
      "use strict";
      
      var SyntheticMouseEvent = _dereq_("./SyntheticMouseEvent");
      
      /**
       * @interface DragEvent
       * @see http://www.w3.org/TR/DOM-Level-3-Events/
       */
      var DragEventInterface = {
        dataTransfer: null
      };
      
      /**
       * @param {object} dispatchConfig Configuration used to dispatch this event.
       * @param {string} dispatchMarker Marker identifying the event target.
       * @param {object} nativeEvent Native browser event.
       * @extends {SyntheticUIEvent}
       */
      function SyntheticDragEvent(dispatchConfig, dispatchMarker, nativeEvent) {
        SyntheticMouseEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
      }
      
      SyntheticMouseEvent.augmentClass(SyntheticDragEvent, DragEventInterface);
      
      module.exports = SyntheticDragEvent;
      
      },{"./SyntheticMouseEvent":88}],84:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SyntheticEvent
       * @typechecks static-only
       */
      
      "use strict";
      
      var PooledClass = _dereq_("./PooledClass");
      
      var emptyFunction = _dereq_("./emptyFunction");
      var getEventTarget = _dereq_("./getEventTarget");
      var merge = _dereq_("./merge");
      var mergeInto = _dereq_("./mergeInto");
      
      /**
       * @interface Event
       * @see http://www.w3.org/TR/DOM-Level-3-Events/
       */
      var EventInterface = {
        type: null,
        target: getEventTarget,
        // currentTarget is set when dispatching; no use in copying it here
        currentTarget: emptyFunction.thatReturnsNull,
        eventPhase: null,
        bubbles: null,
        cancelable: null,
        timeStamp: function(event) {
          return event.timeStamp || Date.now();
        },
        defaultPrevented: null,
        isTrusted: null
      };
      
      /**
       * Synthetic events are dispatched by event plugins, typically in response to a
       * top-level event delegation handler.
       *
       * These systems should generally use pooling to reduce the frequency of garbage
       * collection. The system should check `isPersistent` to determine whether the
       * event should be released into the pool after being dispatched. Users that
       * need a persisted event should invoke `persist`.
       *
       * Synthetic events (and subclasses) implement the DOM Level 3 Events API by
       * normalizing browser quirks. Subclasses do not necessarily have to implement a
       * DOM interface; custom application-specific events can also subclass this.
       *
       * @param {object} dispatchConfig Configuration used to dispatch this event.
       * @param {string} dispatchMarker Marker identifying the event target.
       * @param {object} nativeEvent Native browser event.
       */
      function SyntheticEvent(dispatchConfig, dispatchMarker, nativeEvent) {
        this.dispatchConfig = dispatchConfig;
        this.dispatchMarker = dispatchMarker;
        this.nativeEvent = nativeEvent;
      
        var Interface = this.constructor.Interface;
        for (var propName in Interface) {
          if (!Interface.hasOwnProperty(propName)) {
            continue;
          }
          var normalize = Interface[propName];
          if (normalize) {
            this[propName] = normalize(nativeEvent);
          } else {
            this[propName] = nativeEvent[propName];
          }
        }
      
        var defaultPrevented = nativeEvent.defaultPrevented != null ?
          nativeEvent.defaultPrevented :
          nativeEvent.returnValue === false;
        if (defaultPrevented) {
          this.isDefaultPrevented = emptyFunction.thatReturnsTrue;
        } else {
          this.isDefaultPrevented = emptyFunction.thatReturnsFalse;
        }
        this.isPropagationStopped = emptyFunction.thatReturnsFalse;
      }
      
      mergeInto(SyntheticEvent.prototype, {
      
        preventDefault: function() {
          this.defaultPrevented = true;
          var event = this.nativeEvent;
          event.preventDefault ? event.preventDefault() : event.returnValue = false;
          this.isDefaultPrevented = emptyFunction.thatReturnsTrue;
        },
      
        stopPropagation: function() {
          var event = this.nativeEvent;
          event.stopPropagation ? event.stopPropagation() : event.cancelBubble = true;
          this.isPropagationStopped = emptyFunction.thatReturnsTrue;
        },
      
        /**
         * We release all dispatched `SyntheticEvent`s after each event loop, adding
         * them back into the pool. This allows a way to hold onto a reference that
         * won't be added back into the pool.
         */
        persist: function() {
          this.isPersistent = emptyFunction.thatReturnsTrue;
        },
      
        /**
         * Checks if this event should be released back into the pool.
         *
         * @return {boolean} True if this should not be released, false otherwise.
         */
        isPersistent: emptyFunction.thatReturnsFalse,
      
        /**
         * `PooledClass` looks for `destructor` on each instance it releases.
         */
        destructor: function() {
          var Interface = this.constructor.Interface;
          for (var propName in Interface) {
            this[propName] = null;
          }
          this.dispatchConfig = null;
          this.dispatchMarker = null;
          this.nativeEvent = null;
        }
      
      });
      
      SyntheticEvent.Interface = EventInterface;
      
      /**
       * Helper to reduce boilerplate when creating subclasses.
       *
       * @param {function} Class
       * @param {?object} Interface
       */
      SyntheticEvent.augmentClass = function(Class, Interface) {
        var Super = this;
      
        var prototype = Object.create(Super.prototype);
        mergeInto(prototype, Class.prototype);
        Class.prototype = prototype;
        Class.prototype.constructor = Class;
      
        Class.Interface = merge(Super.Interface, Interface);
        Class.augmentClass = Super.augmentClass;
      
        PooledClass.addPoolingTo(Class, PooledClass.threeArgumentPooler);
      };
      
      PooledClass.addPoolingTo(SyntheticEvent, PooledClass.threeArgumentPooler);
      
      module.exports = SyntheticEvent;
      
      },{"./PooledClass":26,"./emptyFunction":102,"./getEventTarget":111,"./merge":130,"./mergeInto":132}],85:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SyntheticFocusEvent
       * @typechecks static-only
       */
      
      "use strict";
      
      var SyntheticUIEvent = _dereq_("./SyntheticUIEvent");
      
      /**
       * @interface FocusEvent
       * @see http://www.w3.org/TR/DOM-Level-3-Events/
       */
      var FocusEventInterface = {
        relatedTarget: null
      };
      
      /**
       * @param {object} dispatchConfig Configuration used to dispatch this event.
       * @param {string} dispatchMarker Marker identifying the event target.
       * @param {object} nativeEvent Native browser event.
       * @extends {SyntheticUIEvent}
       */
      function SyntheticFocusEvent(dispatchConfig, dispatchMarker, nativeEvent) {
        SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
      }
      
      SyntheticUIEvent.augmentClass(SyntheticFocusEvent, FocusEventInterface);
      
      module.exports = SyntheticFocusEvent;
      
      },{"./SyntheticUIEvent":90}],86:[function(_dereq_,module,exports){
      /**
       * Copyright 2013 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SyntheticInputEvent
       * @typechecks static-only
       */
      
      "use strict";
      
      var SyntheticEvent = _dereq_("./SyntheticEvent");
      
      /**
       * @interface Event
       * @see http://www.w3.org/TR/2013/WD-DOM-Level-3-Events-20131105
       *      /#events-inputevents
       */
      var InputEventInterface = {
        data: null
      };
      
      /**
       * @param {object} dispatchConfig Configuration used to dispatch this event.
       * @param {string} dispatchMarker Marker identifying the event target.
       * @param {object} nativeEvent Native browser event.
       * @extends {SyntheticUIEvent}
       */
      function SyntheticInputEvent(
        dispatchConfig,
        dispatchMarker,
        nativeEvent) {
        SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
      }
      
      SyntheticEvent.augmentClass(
        SyntheticInputEvent,
        InputEventInterface
      );
      
      module.exports = SyntheticInputEvent;
      
      
      },{"./SyntheticEvent":84}],87:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SyntheticKeyboardEvent
       * @typechecks static-only
       */
      
      "use strict";
      
      var SyntheticUIEvent = _dereq_("./SyntheticUIEvent");
      
      var getEventKey = _dereq_("./getEventKey");
      var getEventModifierState = _dereq_("./getEventModifierState");
      
      /**
       * @interface KeyboardEvent
       * @see http://www.w3.org/TR/DOM-Level-3-Events/
       */
      var KeyboardEventInterface = {
        key: getEventKey,
        location: null,
        ctrlKey: null,
        shiftKey: null,
        altKey: null,
        metaKey: null,
        repeat: null,
        locale: null,
        getModifierState: getEventModifierState,
        // Legacy Interface
        charCode: function(event) {
          // `charCode` is the result of a KeyPress event and represents the value of
          // the actual printable character.
      
          // KeyPress is deprecated but its replacement is not yet final and not
          // implemented in any major browser.
          if (event.type === 'keypress') {
            // IE8 does not implement "charCode", but "keyCode" has the correct value.
            return 'charCode' in event ? event.charCode : event.keyCode;
          }
          return 0;
        },
        keyCode: function(event) {
          // `keyCode` is the result of a KeyDown/Up event and represents the value of
          // physical keyboard key.
      
          // The actual meaning of the value depends on the users' keyboard layout
          // which cannot be detected. Assuming that it is a US keyboard layout
          // provides a surprisingly accurate mapping for US and European users.
          // Due to this, it is left to the user to implement at this time.
          if (event.type === 'keydown' || event.type === 'keyup') {
            return event.keyCode;
          }
          return 0;
        },
        which: function(event) {
          // `which` is an alias for either `keyCode` or `charCode` depending on the
          // type of the event. There is no need to determine the type of the event
          // as `keyCode` and `charCode` are either aliased or default to zero.
          return event.keyCode || event.charCode;
        }
      };
      
      /**
       * @param {object} dispatchConfig Configuration used to dispatch this event.
       * @param {string} dispatchMarker Marker identifying the event target.
       * @param {object} nativeEvent Native browser event.
       * @extends {SyntheticUIEvent}
       */
      function SyntheticKeyboardEvent(dispatchConfig, dispatchMarker, nativeEvent) {
        SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
      }
      
      SyntheticUIEvent.augmentClass(SyntheticKeyboardEvent, KeyboardEventInterface);
      
      module.exports = SyntheticKeyboardEvent;
      
      },{"./SyntheticUIEvent":90,"./getEventKey":109,"./getEventModifierState":110}],88:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SyntheticMouseEvent
       * @typechecks static-only
       */
      
      "use strict";
      
      var SyntheticUIEvent = _dereq_("./SyntheticUIEvent");
      var ViewportMetrics = _dereq_("./ViewportMetrics");
      
      var getEventModifierState = _dereq_("./getEventModifierState");
      
      /**
       * @interface MouseEvent
       * @see http://www.w3.org/TR/DOM-Level-3-Events/
       */
      var MouseEventInterface = {
        screenX: null,
        screenY: null,
        clientX: null,
        clientY: null,
        ctrlKey: null,
        shiftKey: null,
        altKey: null,
        metaKey: null,
        getModifierState: getEventModifierState,
        button: function(event) {
          // Webkit, Firefox, IE9+
          // which:  1 2 3
          // button: 0 1 2 (standard)
          var button = event.button;
          if ('which' in event) {
            return button;
          }
          // IE<9
          // which:  undefined
          // button: 0 0 0
          // button: 1 4 2 (onmouseup)
          return button === 2 ? 2 : button === 4 ? 1 : 0;
        },
        buttons: null,
        relatedTarget: function(event) {
          return event.relatedTarget || (
            event.fromElement === event.srcElement ?
              event.toElement :
              event.fromElement
          );
        },
        // "Proprietary" Interface.
        pageX: function(event) {
          return 'pageX' in event ?
            event.pageX :
            event.clientX + ViewportMetrics.currentScrollLeft;
        },
        pageY: function(event) {
          return 'pageY' in event ?
            event.pageY :
            event.clientY + ViewportMetrics.currentScrollTop;
        }
      };
      
      /**
       * @param {object} dispatchConfig Configuration used to dispatch this event.
       * @param {string} dispatchMarker Marker identifying the event target.
       * @param {object} nativeEvent Native browser event.
       * @extends {SyntheticUIEvent}
       */
      function SyntheticMouseEvent(dispatchConfig, dispatchMarker, nativeEvent) {
        SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
      }
      
      SyntheticUIEvent.augmentClass(SyntheticMouseEvent, MouseEventInterface);
      
      module.exports = SyntheticMouseEvent;
      
      },{"./SyntheticUIEvent":90,"./ViewportMetrics":93,"./getEventModifierState":110}],89:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SyntheticTouchEvent
       * @typechecks static-only
       */
      
      "use strict";
      
      var SyntheticUIEvent = _dereq_("./SyntheticUIEvent");
      
      var getEventModifierState = _dereq_("./getEventModifierState");
      
      /**
       * @interface TouchEvent
       * @see http://www.w3.org/TR/touch-events/
       */
      var TouchEventInterface = {
        touches: null,
        targetTouches: null,
        changedTouches: null,
        altKey: null,
        metaKey: null,
        ctrlKey: null,
        shiftKey: null,
        getModifierState: getEventModifierState
      };
      
      /**
       * @param {object} dispatchConfig Configuration used to dispatch this event.
       * @param {string} dispatchMarker Marker identifying the event target.
       * @param {object} nativeEvent Native browser event.
       * @extends {SyntheticUIEvent}
       */
      function SyntheticTouchEvent(dispatchConfig, dispatchMarker, nativeEvent) {
        SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
      }
      
      SyntheticUIEvent.augmentClass(SyntheticTouchEvent, TouchEventInterface);
      
      module.exports = SyntheticTouchEvent;
      
      },{"./SyntheticUIEvent":90,"./getEventModifierState":110}],90:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SyntheticUIEvent
       * @typechecks static-only
       */
      
      "use strict";
      
      var SyntheticEvent = _dereq_("./SyntheticEvent");
      
      var getEventTarget = _dereq_("./getEventTarget");
      
      /**
       * @interface UIEvent
       * @see http://www.w3.org/TR/DOM-Level-3-Events/
       */
      var UIEventInterface = {
        view: function(event) {
          if (event.view) {
            return event.view;
          }
      
          var target = getEventTarget(event);
          if (target != null && target.window === target) {
            // target is a window object
            return target;
          }
      
          var doc = target.ownerDocument;
          // TODO: Figure out why `ownerDocument` is sometimes undefined in IE8.
          if (doc) {
            return doc.defaultView || doc.parentWindow;
          } else {
            return window;
          }
        },
        detail: function(event) {
          return event.detail || 0;
        }
      };
      
      /**
       * @param {object} dispatchConfig Configuration used to dispatch this event.
       * @param {string} dispatchMarker Marker identifying the event target.
       * @param {object} nativeEvent Native browser event.
       * @extends {SyntheticEvent}
       */
      function SyntheticUIEvent(dispatchConfig, dispatchMarker, nativeEvent) {
        SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
      }
      
      SyntheticEvent.augmentClass(SyntheticUIEvent, UIEventInterface);
      
      module.exports = SyntheticUIEvent;
      
      },{"./SyntheticEvent":84,"./getEventTarget":111}],91:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule SyntheticWheelEvent
       * @typechecks static-only
       */
      
      "use strict";
      
      var SyntheticMouseEvent = _dereq_("./SyntheticMouseEvent");
      
      /**
       * @interface WheelEvent
       * @see http://www.w3.org/TR/DOM-Level-3-Events/
       */
      var WheelEventInterface = {
        deltaX: function(event) {
          return (
            'deltaX' in event ? event.deltaX :
            // Fallback to `wheelDeltaX` for Webkit and normalize (right is positive).
            'wheelDeltaX' in event ? -event.wheelDeltaX : 0
          );
        },
        deltaY: function(event) {
          return (
            'deltaY' in event ? event.deltaY :
            // Fallback to `wheelDeltaY` for Webkit and normalize (down is positive).
            'wheelDeltaY' in event ? -event.wheelDeltaY :
            // Fallback to `wheelDelta` for IE<9 and normalize (down is positive).
            'wheelDelta' in event ? -event.wheelDelta : 0
          );
        },
        deltaZ: null,
      
        // Browsers without "deltaMode" is reporting in raw wheel delta where one
        // notch on the scroll is always +/- 120, roughly equivalent to pixels.
        // A good approximation of DOM_DELTA_LINE (1) is 5% of viewport size or
        // ~40 pixels, for DOM_DELTA_SCREEN (2) it is 87.5% of viewport size.
        deltaMode: null
      };
      
      /**
       * @param {object} dispatchConfig Configuration used to dispatch this event.
       * @param {string} dispatchMarker Marker identifying the event target.
       * @param {object} nativeEvent Native browser event.
       * @extends {SyntheticMouseEvent}
       */
      function SyntheticWheelEvent(dispatchConfig, dispatchMarker, nativeEvent) {
        SyntheticMouseEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
      }
      
      SyntheticMouseEvent.augmentClass(SyntheticWheelEvent, WheelEventInterface);
      
      module.exports = SyntheticWheelEvent;
      
      },{"./SyntheticMouseEvent":88}],92:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule Transaction
       */
      
      "use strict";
      
      var invariant = _dereq_("./invariant");
      
      /**
       * `Transaction` creates a black box that is able to wrap any method such that
       * certain invariants are maintained before and after the method is invoked
       * (Even if an exception is thrown while invoking the wrapped method). Whoever
       * instantiates a transaction can provide enforcers of the invariants at
       * creation time. The `Transaction` class itself will supply one additional
       * automatic invariant for you - the invariant that any transaction instance
       * should not be run while it is already being run. You would typically create a
       * single instance of a `Transaction` for reuse multiple times, that potentially
       * is used to wrap several different methods. Wrappers are extremely simple -
       * they only require implementing two methods.
       *
       * <pre>
       *                       wrappers (injected at creation time)
       *                                      +        +
       *                                      |        |
       *                    +-----------------|--------|--------------+
       *                    |                 v        |              |
       *                    |      +---------------+   |              |
       *                    |   +--|    wrapper1   |---|----+         |
       *                    |   |  +---------------+   v    |         |
       *                    |   |          +-------------+  |         |
       *                    |   |     +----|   wrapper2  |--------+   |
       *                    |   |     |    +-------------+  |     |   |
       *                    |   |     |                     |     |   |
       *                    |   v     v                     v     v   | wrapper
       *                    | +---+ +---+   +---------+   +---+ +---+ | invariants
       * perform(anyMethod) | |   | |   |   |         |   |   | |   | | maintained
       * +----------------->|-|---|-|---|-->|anyMethod|---|---|-|---|-|-------->
       *                    | |   | |   |   |         |   |   | |   | |
       *                    | |   | |   |   |         |   |   | |   | |
       *                    | |   | |   |   |         |   |   | |   | |
       *                    | +---+ +---+   +---------+   +---+ +---+ |
       *                    |  initialize                    close    |
       *                    +-----------------------------------------+
       * </pre>
       *
       * Use cases:
       * - Preserving the input selection ranges before/after reconciliation.
       *   Restoring selection even in the event of an unexpected error.
       * - Deactivating events while rearranging the DOM, preventing blurs/focuses,
       *   while guaranteeing that afterwards, the event system is reactivated.
       * - Flushing a queue of collected DOM mutations to the main UI thread after a
       *   reconciliation takes place in a worker thread.
       * - Invoking any collected `componentDidUpdate` callbacks after rendering new
       *   content.
       * - (Future use case): Wrapping particular flushes of the `ReactWorker` queue
       *   to preserve the `scrollTop` (an automatic scroll aware DOM).
       * - (Future use case): Layout calculations before and after DOM upates.
       *
       * Transactional plugin API:
       * - A module that has an `initialize` method that returns any precomputation.
       * - and a `close` method that accepts the precomputation. `close` is invoked
       *   when the wrapped process is completed, or has failed.
       *
       * @param {Array<TransactionalWrapper>} transactionWrapper Wrapper modules
       * that implement `initialize` and `close`.
       * @return {Transaction} Single transaction for reuse in thread.
       *
       * @class Transaction
       */
      var Mixin = {
        /**
         * Sets up this instance so that it is prepared for collecting metrics. Does
         * so such that this setup method may be used on an instance that is already
         * initialized, in a way that does not consume additional memory upon reuse.
         * That can be useful if you decide to make your subclass of this mixin a
         * "PooledClass".
         */
        reinitializeTransaction: function() {
          this.transactionWrappers = this.getTransactionWrappers();
          if (!this.wrapperInitData) {
            this.wrapperInitData = [];
          } else {
            this.wrapperInitData.length = 0;
          }
          this._isInTransaction = false;
        },
      
        _isInTransaction: false,
      
        /**
         * @abstract
         * @return {Array<TransactionWrapper>} Array of transaction wrappers.
         */
        getTransactionWrappers: null,
      
        isInTransaction: function() {
          return !!this._isInTransaction;
        },
      
        /**
         * Executes the function within a safety window. Use this for the top level
         * methods that result in large amounts of computation/mutations that would
         * need to be safety checked.
         *
         * @param {function} method Member of scope to call.
         * @param {Object} scope Scope to invoke from.
         * @param {Object?=} args... Arguments to pass to the method (optional).
         *                           Helps prevent need to bind in many cases.
         * @return Return value from `method`.
         */
        perform: function(method, scope, a, b, c, d, e, f) {
          ("production" !== "development" ? invariant(
            !this.isInTransaction(),
            'Transaction.perform(...): Cannot initialize a transaction when there ' +
            'is already an outstanding transaction.'
          ) : invariant(!this.isInTransaction()));
          var errorThrown;
          var ret;
          try {
            this._isInTransaction = true;
            // Catching errors makes debugging more difficult, so we start with
            // errorThrown set to true before setting it to false after calling
            // close -- if it's still set to true in the finally block, it means
            // one of these calls threw.
            errorThrown = true;
            this.initializeAll(0);
            ret = method.call(scope, a, b, c, d, e, f);
            errorThrown = false;
          } finally {
            try {
              if (errorThrown) {
                // If `method` throws, prefer to show that stack trace over any thrown
                // by invoking `closeAll`.
                try {
                  this.closeAll(0);
                } catch (err) {
                }
              } else {
                // Since `method` didn't throw, we don't want to silence the exception
                // here.
                this.closeAll(0);
              }
            } finally {
              this._isInTransaction = false;
            }
          }
          return ret;
        },
      
        initializeAll: function(startIndex) {
          var transactionWrappers = this.transactionWrappers;
          for (var i = startIndex; i < transactionWrappers.length; i++) {
            var wrapper = transactionWrappers[i];
            try {
              // Catching errors makes debugging more difficult, so we start with the
              // OBSERVED_ERROR state before overwriting it with the real return value
              // of initialize -- if it's still set to OBSERVED_ERROR in the finally
              // block, it means wrapper.initialize threw.
              this.wrapperInitData[i] = Transaction.OBSERVED_ERROR;
              this.wrapperInitData[i] = wrapper.initialize ?
                wrapper.initialize.call(this) :
                null;
            } finally {
              if (this.wrapperInitData[i] === Transaction.OBSERVED_ERROR) {
                // The initializer for wrapper i threw an error; initialize the
                // remaining wrappers but silence any exceptions from them to ensure
                // that the first error is the one to bubble up.
                try {
                  this.initializeAll(i + 1);
                } catch (err) {
                }
              }
            }
          }
        },
      
        /**
         * Invokes each of `this.transactionWrappers.close[i]` functions, passing into
         * them the respective return values of `this.transactionWrappers.init[i]`
         * (`close`rs that correspond to initializers that failed will not be
         * invoked).
         */
        closeAll: function(startIndex) {
          ("production" !== "development" ? invariant(
            this.isInTransaction(),
            'Transaction.closeAll(): Cannot close transaction when none are open.'
          ) : invariant(this.isInTransaction()));
          var transactionWrappers = this.transactionWrappers;
          for (var i = startIndex; i < transactionWrappers.length; i++) {
            var wrapper = transactionWrappers[i];
            var initData = this.wrapperInitData[i];
            var errorThrown;
            try {
              // Catching errors makes debugging more difficult, so we start with
              // errorThrown set to true before setting it to false after calling
              // close -- if it's still set to true in the finally block, it means
              // wrapper.close threw.
              errorThrown = true;
              if (initData !== Transaction.OBSERVED_ERROR) {
                wrapper.close && wrapper.close.call(this, initData);
              }
              errorThrown = false;
            } finally {
              if (errorThrown) {
                // The closer for wrapper i threw an error; close the remaining
                // wrappers but silence any exceptions from them to ensure that the
                // first error is the one to bubble up.
                try {
                  this.closeAll(i + 1);
                } catch (e) {
                }
              }
            }
          }
          this.wrapperInitData.length = 0;
        }
      };
      
      var Transaction = {
      
        Mixin: Mixin,
      
        /**
         * Token to look for to determine if an error occured.
         */
        OBSERVED_ERROR: {}
      
      };
      
      module.exports = Transaction;
      
      },{"./invariant":120}],93:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule ViewportMetrics
       */
      
      "use strict";
      
      var getUnboundedScrollPosition = _dereq_("./getUnboundedScrollPosition");
      
      var ViewportMetrics = {
      
        currentScrollLeft: 0,
      
        currentScrollTop: 0,
      
        refreshScrollValues: function() {
          var scrollPosition = getUnboundedScrollPosition(window);
          ViewportMetrics.currentScrollLeft = scrollPosition.x;
          ViewportMetrics.currentScrollTop = scrollPosition.y;
        }
      
      };
      
      module.exports = ViewportMetrics;
      
      },{"./getUnboundedScrollPosition":116}],94:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule accumulate
       */
      
      "use strict";
      
      var invariant = _dereq_("./invariant");
      
      /**
       * Accumulates items that must not be null or undefined.
       *
       * This is used to conserve memory by avoiding array allocations.
       *
       * @return {*|array<*>} An accumulation of items.
       */
      function accumulate(current, next) {
        ("production" !== "development" ? invariant(
          next != null,
          'accumulate(...): Accumulated items must be not be null or undefined.'
        ) : invariant(next != null));
        if (current == null) {
          return next;
        } else {
          // Both are not empty. Warning: Never call x.concat(y) when you are not
          // certain that x is an Array (x could be a string with concat method).
          var currentIsArray = Array.isArray(current);
          var nextIsArray = Array.isArray(next);
          if (currentIsArray) {
            return current.concat(next);
          } else {
            if (nextIsArray) {
              return [current].concat(next);
            } else {
              return [current, next];
            }
          }
        }
      }
      
      module.exports = accumulate;
      
      },{"./invariant":120}],95:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule adler32
       */
      
      /* jslint bitwise:true */
      
      "use strict";
      
      var MOD = 65521;
      
      // This is a clean-room implementation of adler32 designed for detecting
      // if markup is not what we expect it to be. It does not need to be
      // cryptographically strong, only reasonable good at detecting if markup
      // generated on the server is different than that on the client.
      function adler32(data) {
        var a = 1;
        var b = 0;
        for (var i = 0; i < data.length; i++) {
          a = (a + data.charCodeAt(i)) % MOD;
          b = (b + a) % MOD;
        }
        return a | (b << 16);
      }
      
      module.exports = adler32;
      
      },{}],96:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule containsNode
       * @typechecks
       */
      
      var isTextNode = _dereq_("./isTextNode");
      
      /*jslint bitwise:true */
      
      /**
       * Checks if a given DOM node contains or is another DOM node.
       *
       * @param {?DOMNode} outerNode Outer DOM node.
       * @param {?DOMNode} innerNode Inner DOM node.
       * @return {boolean} True if `outerNode` contains or is `innerNode`.
       */
      function containsNode(outerNode, innerNode) {
        if (!outerNode || !innerNode) {
          return false;
        } else if (outerNode === innerNode) {
          return true;
        } else if (isTextNode(outerNode)) {
          return false;
        } else if (isTextNode(innerNode)) {
          return containsNode(outerNode, innerNode.parentNode);
        } else if (outerNode.contains) {
          return outerNode.contains(innerNode);
        } else if (outerNode.compareDocumentPosition) {
          return !!(outerNode.compareDocumentPosition(innerNode) & 16);
        } else {
          return false;
        }
      }
      
      module.exports = containsNode;
      
      },{"./isTextNode":124}],97:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule copyProperties
       */
      
      /**
       * Copy properties from one or more objects (up to 5) into the first object.
       * This is a shallow copy. It mutates the first object and also returns it.
       *
       * NOTE: `arguments` has a very significant performance penalty, which is why
       * we don't support unlimited arguments.
       */
      function copyProperties(obj, a, b, c, d, e, f) {
        obj = obj || {};
      
        if ("production" !== "development") {
          if (f) {
            throw new Error('Too many arguments passed to copyProperties');
          }
        }
      
        var args = [a, b, c, d, e];
        var ii = 0, v;
        while (args[ii]) {
          v = args[ii++];
          for (var k in v) {
            obj[k] = v[k];
          }
      
          // IE ignores toString in object iteration.. See:
          // webreflection.blogspot.com/2007/07/quick-fix-internet-explorer-and.html
          if (v.hasOwnProperty && v.hasOwnProperty('toString') &&
              (typeof v.toString != 'undefined') && (obj.toString !== v.toString)) {
            obj.toString = v.toString;
          }
        }
      
        return obj;
      }
      
      module.exports = copyProperties;
      
      },{}],98:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule createArrayFrom
       * @typechecks
       */
      
      var toArray = _dereq_("./toArray");
      
      /**
       * Perform a heuristic test to determine if an object is "array-like".
       *
       *   A monk asked Joshu, a Zen master, "Has a dog Buddha nature?"
       *   Joshu replied: "Mu."
       *
       * This function determines if its argument has "array nature": it returns
       * true if the argument is an actual array, an `arguments' object, or an
       * HTMLCollection (e.g. node.childNodes or node.getElementsByTagName()).
       *
       * It will return false for other array-like objects like Filelist.
       *
       * @param {*} obj
       * @return {boolean}
       */
      function hasArrayNature(obj) {
        return (
          // not null/false
          !!obj &&
          // arrays are objects, NodeLists are functions in Safari
          (typeof obj == 'object' || typeof obj == 'function') &&
          // quacks like an array
          ('length' in obj) &&
          // not window
          !('setInterval' in obj) &&
          // no DOM node should be considered an array-like
          // a 'select' element has 'length' and 'item' properties on IE8
          (typeof obj.nodeType != 'number') &&
          (
            // a real array
            (// HTMLCollection/NodeList
            (Array.isArray(obj) ||
            // arguments
            ('callee' in obj) || 'item' in obj))
          )
        );
      }
      
      /**
       * Ensure that the argument is an array by wrapping it in an array if it is not.
       * Creates a copy of the argument if it is already an array.
       *
       * This is mostly useful idiomatically:
       *
       *   var createArrayFrom = require('createArrayFrom');
       *
       *   function takesOneOrMoreThings(things) {
       *     things = createArrayFrom(things);
       *     ...
       *   }
       *
       * This allows you to treat `things' as an array, but accept scalars in the API.
       *
       * If you need to convert an array-like object, like `arguments`, into an array
       * use toArray instead.
       *
       * @param {*} obj
       * @return {array}
       */
      function createArrayFrom(obj) {
        if (!hasArrayNature(obj)) {
          return [obj];
        } else if (Array.isArray(obj)) {
          return obj.slice();
        } else {
          return toArray(obj);
        }
      }
      
      module.exports = createArrayFrom;
      
      },{"./toArray":141}],99:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule createFullPageComponent
       * @typechecks
       */
      
      "use strict";
      
      // Defeat circular references by requiring this directly.
      var ReactCompositeComponent = _dereq_("./ReactCompositeComponent");
      
      var invariant = _dereq_("./invariant");
      
      /**
       * Create a component that will throw an exception when unmounted.
       *
       * Components like <html> <head> and <body> can't be removed or added
       * easily in a cross-browser way, however it's valuable to be able to
       * take advantage of React's reconciliation for styling and <title>
       * management. So we just document it and throw in dangerous cases.
       *
       * @param {function} componentClass convenience constructor to wrap
       * @return {function} convenience constructor of new component
       */
      function createFullPageComponent(componentClass) {
        var FullPageComponent = ReactCompositeComponent.createClass({
          displayName: 'ReactFullPageComponent' + (
            componentClass.type.displayName || ''
          ),
      
          componentWillUnmount: function() {
            ("production" !== "development" ? invariant(
              false,
              '%s tried to unmount. Because of cross-browser quirks it is ' +
              'impossible to unmount some top-level components (eg <html>, <head>, ' +
              'and <body>) reliably and efficiently. To fix this, have a single ' +
              'top-level component that never unmounts render these elements.',
              this.constructor.displayName
            ) : invariant(false));
          },
      
          render: function() {
            return this.transferPropsTo(componentClass(null, this.props.children));
          }
        });
      
        return FullPageComponent;
      }
      
      module.exports = createFullPageComponent;
      
      },{"./ReactCompositeComponent":33,"./invariant":120}],100:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule createNodesFromMarkup
       * @typechecks
       */
      
      /*jslint evil: true, sub: true */
      
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      
      var createArrayFrom = _dereq_("./createArrayFrom");
      var getMarkupWrap = _dereq_("./getMarkupWrap");
      var invariant = _dereq_("./invariant");
      
      /**
       * Dummy container used to render all markup.
       */
      var dummyNode =
        ExecutionEnvironment.canUseDOM ? document.createElement('div') : null;
      
      /**
       * Pattern used by `getNodeName`.
       */
      var nodeNamePattern = /^\s*<(\w+)/;
      
      /**
       * Extracts the `nodeName` of the first element in a string of markup.
       *
       * @param {string} markup String of markup.
       * @return {?string} Node name of the supplied markup.
       */
      function getNodeName(markup) {
        var nodeNameMatch = markup.match(nodeNamePattern);
        return nodeNameMatch && nodeNameMatch[1].toLowerCase();
      }
      
      /**
       * Creates an array containing the nodes rendered from the supplied markup. The
       * optionally supplied `handleScript` function will be invoked once for each
       * <script> element that is rendered. If no `handleScript` function is supplied,
       * an exception is thrown if any <script> elements are rendered.
       *
       * @param {string} markup A string of valid HTML markup.
       * @param {?function} handleScript Invoked once for each rendered <script>.
       * @return {array<DOMElement|DOMTextNode>} An array of rendered nodes.
       */
      function createNodesFromMarkup(markup, handleScript) {
        var node = dummyNode;
        ("production" !== "development" ? invariant(!!dummyNode, 'createNodesFromMarkup dummy not initialized') : invariant(!!dummyNode));
        var nodeName = getNodeName(markup);
      
        var wrap = nodeName && getMarkupWrap(nodeName);
        if (wrap) {
          node.innerHTML = wrap[1] + markup + wrap[2];
      
          var wrapDepth = wrap[0];
          while (wrapDepth--) {
            node = node.lastChild;
          }
        } else {
          node.innerHTML = markup;
        }
      
        var scripts = node.getElementsByTagName('script');
        if (scripts.length) {
          ("production" !== "development" ? invariant(
            handleScript,
            'createNodesFromMarkup(...): Unexpected <script> element rendered.'
          ) : invariant(handleScript));
          createArrayFrom(scripts).forEach(handleScript);
        }
      
        var nodes = createArrayFrom(node.childNodes);
        while (node.lastChild) {
          node.removeChild(node.lastChild);
        }
        return nodes;
      }
      
      module.exports = createNodesFromMarkup;
      
      },{"./ExecutionEnvironment":21,"./createArrayFrom":98,"./getMarkupWrap":112,"./invariant":120}],101:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule dangerousStyleValue
       * @typechecks static-only
       */
      
      "use strict";
      
      var CSSProperty = _dereq_("./CSSProperty");
      
      var isUnitlessNumber = CSSProperty.isUnitlessNumber;
      
      /**
       * Convert a value into the proper css writable value. The style name `name`
       * should be logical (no hyphens), as specified
       * in `CSSProperty.isUnitlessNumber`.
       *
       * @param {string} name CSS property name such as `topMargin`.
       * @param {*} value CSS property value such as `10px`.
       * @return {string} Normalized style value with dimensions applied.
       */
      function dangerousStyleValue(name, value) {
        // Note that we've removed escapeTextForBrowser() calls here since the
        // whole string will be escaped when the attribute is injected into
        // the markup. If you provide unsafe user data here they can inject
        // arbitrary CSS which may be problematic (I couldn't repro this):
        // https://www.owasp.org/index.php/XSS_Filter_Evasion_Cheat_Sheet
        // http://www.thespanner.co.uk/2007/11/26/ultimate-xss-css-injection/
        // This is not an XSS hole but instead a potential CSS injection issue
        // which has lead to a greater discussion about how we're going to
        // trust URLs moving forward. See #2115901
      
        var isEmpty = value == null || typeof value === 'boolean' || value === '';
        if (isEmpty) {
          return '';
        }
      
        var isNonNumeric = isNaN(value);
        if (isNonNumeric || value === 0 ||
            isUnitlessNumber.hasOwnProperty(name) && isUnitlessNumber[name]) {
          return '' + value; // cast to string
        }
      
        if (typeof value === 'string') {
          value = value.trim();
        }
        return value + 'px';
      }
      
      module.exports = dangerousStyleValue;
      
      },{"./CSSProperty":3}],102:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule emptyFunction
       */
      
      var copyProperties = _dereq_("./copyProperties");
      
      function makeEmptyFunction(arg) {
        return function() {
          return arg;
        };
      }
      
      /**
       * This function accepts and discards inputs; it has no side effects. This is
       * primarily useful idiomatically for overridable function endpoints which
       * always need to be callable, since JS lacks a null-call idiom ala Cocoa.
       */
      function emptyFunction() {}
      
      copyProperties(emptyFunction, {
        thatReturns: makeEmptyFunction,
        thatReturnsFalse: makeEmptyFunction(false),
        thatReturnsTrue: makeEmptyFunction(true),
        thatReturnsNull: makeEmptyFunction(null),
        thatReturnsThis: function() { return this; },
        thatReturnsArgument: function(arg) { return arg; }
      });
      
      module.exports = emptyFunction;
      
      },{"./copyProperties":97}],103:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule emptyObject
       */
      
      "use strict";
      
      var emptyObject = {};
      
      if ("production" !== "development") {
        Object.freeze(emptyObject);
      }
      
      module.exports = emptyObject;
      
      },{}],104:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule escapeTextForBrowser
       * @typechecks static-only
       */
      
      "use strict";
      
      var ESCAPE_LOOKUP = {
        "&": "&amp;",
        ">": "&gt;",
        "<": "&lt;",
        "\"": "&quot;",
        "'": "&#x27;"
      };
      
      var ESCAPE_REGEX = /[&><"']/g;
      
      function escaper(match) {
        return ESCAPE_LOOKUP[match];
      }
      
      /**
       * Escapes text to prevent scripting attacks.
       *
       * @param {*} text Text value to escape.
       * @return {string} An escaped string.
       */
      function escapeTextForBrowser(text) {
        return ('' + text).replace(ESCAPE_REGEX, escaper);
      }
      
      module.exports = escapeTextForBrowser;
      
      },{}],105:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule flattenChildren
       */
      
      "use strict";
      
      var traverseAllChildren = _dereq_("./traverseAllChildren");
      var warning = _dereq_("./warning");
      
      /**
       * @param {function} traverseContext Context passed through traversal.
       * @param {?ReactComponent} child React child component.
       * @param {!string} name String name of key path to child.
       */
      function flattenSingleChildIntoContext(traverseContext, child, name) {
        // We found a component instance.
        var result = traverseContext;
        var keyUnique = !result.hasOwnProperty(name);
        ("production" !== "development" ? warning(
          keyUnique,
          'flattenChildren(...): Encountered two children with the same key, ' +
          '`%s`. Child keys must be unique; when two children share a key, only ' +
          'the first child will be used.',
          name
        ) : null);
        if (keyUnique && child != null) {
          result[name] = child;
        }
      }
      
      /**
       * Flattens children that are typically specified as `props.children`. Any null
       * children will not be included in the resulting object.
       * @return {!object} flattened children keyed by name.
       */
      function flattenChildren(children) {
        if (children == null) {
          return children;
        }
        var result = {};
        traverseAllChildren(children, flattenSingleChildIntoContext, result);
        return result;
      }
      
      module.exports = flattenChildren;
      
      },{"./traverseAllChildren":142,"./warning":143}],106:[function(_dereq_,module,exports){
      /**
       * Copyright 2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule focusNode
       */
      
      "use strict";
      
      /**
       * IE8 throws if an input/textarea is disabled and we try to focus it.
       * Focus only when necessary.
       *
       * @param {DOMElement} node input/textarea to focus
       */
      function focusNode(node) {
        if (!node.disabled) {
          node.focus();
        }
      }
      
      module.exports = focusNode;
      
      },{}],107:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule forEachAccumulated
       */
      
      "use strict";
      
      /**
       * @param {array} an "accumulation" of items which is either an Array or
       * a single item. Useful when paired with the `accumulate` module. This is a
       * simple utility that allows us to reason about a collection of items, but
       * handling the case when there is exactly one item (and we do not need to
       * allocate an array).
       */
      var forEachAccumulated = function(arr, cb, scope) {
        if (Array.isArray(arr)) {
          arr.forEach(cb, scope);
        } else if (arr) {
          cb.call(scope, arr);
        }
      };
      
      module.exports = forEachAccumulated;
      
      },{}],108:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule getActiveElement
       * @typechecks
       */
      
      /**
       * Same as document.activeElement but wraps in a try-catch block. In IE it is
       * not safe to call document.activeElement if there is nothing focused.
       *
       * The activeElement will be null only if the document body is not yet defined.
       */
      function getActiveElement() /*?DOMElement*/ {
        try {
          return document.activeElement || document.body;
        } catch (e) {
          return document.body;
        }
      }
      
      module.exports = getActiveElement;
      
      },{}],109:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule getEventKey
       * @typechecks static-only
       */
      
      "use strict";
      
      var invariant = _dereq_("./invariant");
      
      /**
       * Normalization of deprecated HTML5 `key` values
       * @see https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent#Key_names
       */
      var normalizeKey = {
        'Esc': 'Escape',
        'Spacebar': ' ',
        'Left': 'ArrowLeft',
        'Up': 'ArrowUp',
        'Right': 'ArrowRight',
        'Down': 'ArrowDown',
        'Del': 'Delete',
        'Win': 'OS',
        'Menu': 'ContextMenu',
        'Apps': 'ContextMenu',
        'Scroll': 'ScrollLock',
        'MozPrintableKey': 'Unidentified'
      };
      
      /**
       * Translation from legacy `which`/`keyCode` to HTML5 `key`
       * Only special keys supported, all others depend on keyboard layout or browser
       * @see https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent#Key_names
       */
      var translateToKey = {
        8: 'Backspace',
        9: 'Tab',
        12: 'Clear',
        13: 'Enter',
        16: 'Shift',
        17: 'Control',
        18: 'Alt',
        19: 'Pause',
        20: 'CapsLock',
        27: 'Escape',
        32: ' ',
        33: 'PageUp',
        34: 'PageDown',
        35: 'End',
        36: 'Home',
        37: 'ArrowLeft',
        38: 'ArrowUp',
        39: 'ArrowRight',
        40: 'ArrowDown',
        45: 'Insert',
        46: 'Delete',
        112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4', 116: 'F5', 117: 'F6',
        118: 'F7', 119: 'F8', 120: 'F9', 121: 'F10', 122: 'F11', 123: 'F12',
        144: 'NumLock',
        145: 'ScrollLock',
        224: 'Meta'
      };
      
      /**
       * @param {object} nativeEvent Native browser event.
       * @return {string} Normalized `key` property.
       */
      function getEventKey(nativeEvent) {
        if (nativeEvent.key) {
          // Normalize inconsistent values reported by browsers due to
          // implementations of a working draft specification.
      
          // FireFox implements `key` but returns `MozPrintableKey` for all
          // printable characters (normalized to `Unidentified`), ignore it.
          var key = normalizeKey[nativeEvent.key] || nativeEvent.key;
          if (key !== 'Unidentified') {
            return key;
          }
        }
      
        // Browser does not implement `key`, polyfill as much of it as we can.
        if (nativeEvent.type === 'keypress') {
          // Create the character from the `charCode` ourselves and use as an almost
          // perfect replacement.
          var charCode = 'charCode' in nativeEvent ?
            nativeEvent.charCode :
            nativeEvent.keyCode;
      
          // The enter-key is technically both printable and non-printable and can
          // thus be captured by `keypress`, no other non-printable key should.
          return charCode === 13 ? 'Enter' : String.fromCharCode(charCode);
        }
        if (nativeEvent.type === 'keydown' || nativeEvent.type === 'keyup') {
          // While user keyboard layout determines the actual meaning of each
          // `keyCode` value, almost all function keys have a universal value.
          return translateToKey[nativeEvent.keyCode] || 'Unidentified';
        }
      
        ("production" !== "development" ? invariant(false, "Unexpected keyboard event type: %s", nativeEvent.type) : invariant(false));
      }
      
      module.exports = getEventKey;
      
      },{"./invariant":120}],110:[function(_dereq_,module,exports){
      /**
       * Copyright 2013 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule getEventModifierState
       * @typechecks static-only
       */
      
      "use strict";
      
      /**
       * Translation from modifier key to the associated property in the event.
       * @see http://www.w3.org/TR/DOM-Level-3-Events/#keys-Modifiers
       */
      
      var modifierKeyToProp = {
        'Alt': 'altKey',
        'Control': 'ctrlKey',
        'Meta': 'metaKey',
        'Shift': 'shiftKey'
      };
      
      // IE8 does not implement getModifierState so we simply map it to the only
      // modifier keys exposed by the event itself, does not support Lock-keys.
      // Currently, all major browsers except Chrome seems to support Lock-keys.
      function modifierStateGetter(keyArg) {
        /*jshint validthis:true */
        var syntheticEvent = this;
        var nativeEvent = syntheticEvent.nativeEvent;
        if (nativeEvent.getModifierState) {
          return nativeEvent.getModifierState(keyArg);
        }
        var keyProp = modifierKeyToProp[keyArg];
        return keyProp ? !!nativeEvent[keyProp] : false;
      }
      
      function getEventModifierState(nativeEvent) {
        return modifierStateGetter;
      }
      
      module.exports = getEventModifierState;
      
      },{}],111:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule getEventTarget
       * @typechecks static-only
       */
      
      "use strict";
      
      /**
       * Gets the target node from a native browser event by accounting for
       * inconsistencies in browser DOM APIs.
       *
       * @param {object} nativeEvent Native browser event.
       * @return {DOMEventTarget} Target node.
       */
      function getEventTarget(nativeEvent) {
        var target = nativeEvent.target || nativeEvent.srcElement || window;
        // Safari may fire events on text nodes (Node.TEXT_NODE is 3).
        // @see http://www.quirksmode.org/js/events_properties.html
        return target.nodeType === 3 ? target.parentNode : target;
      }
      
      module.exports = getEventTarget;
      
      },{}],112:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule getMarkupWrap
       */
      
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      
      var invariant = _dereq_("./invariant");
      
      /**
       * Dummy container used to detect which wraps are necessary.
       */
      var dummyNode =
        ExecutionEnvironment.canUseDOM ? document.createElement('div') : null;
      
      /**
       * Some browsers cannot use `innerHTML` to render certain elements standalone,
       * so we wrap them, render the wrapped nodes, then extract the desired node.
       *
       * In IE8, certain elements cannot render alone, so wrap all elements ('*').
       */
      var shouldWrap = {
        // Force wrapping for SVG elements because if they get created inside a <div>,
        // they will be initialized in the wrong namespace (and will not display).
        'circle': true,
        'defs': true,
        'ellipse': true,
        'g': true,
        'line': true,
        'linearGradient': true,
        'path': true,
        'polygon': true,
        'polyline': true,
        'radialGradient': true,
        'rect': true,
        'stop': true,
        'text': true
      };
      
      var selectWrap = [1, '<select multiple="true">', '</select>'];
      var tableWrap = [1, '<table>', '</table>'];
      var trWrap = [3, '<table><tbody><tr>', '</tr></tbody></table>'];
      
      var svgWrap = [1, '<svg>', '</svg>'];
      
      var markupWrap = {
        '*': [1, '?<div>', '</div>'],
      
        'area': [1, '<map>', '</map>'],
        'col': [2, '<table><tbody></tbody><colgroup>', '</colgroup></table>'],
        'legend': [1, '<fieldset>', '</fieldset>'],
        'param': [1, '<object>', '</object>'],
        'tr': [2, '<table><tbody>', '</tbody></table>'],
      
        'optgroup': selectWrap,
        'option': selectWrap,
      
        'caption': tableWrap,
        'colgroup': tableWrap,
        'tbody': tableWrap,
        'tfoot': tableWrap,
        'thead': tableWrap,
      
        'td': trWrap,
        'th': trWrap,
      
        'circle': svgWrap,
        'defs': svgWrap,
        'ellipse': svgWrap,
        'g': svgWrap,
        'line': svgWrap,
        'linearGradient': svgWrap,
        'path': svgWrap,
        'polygon': svgWrap,
        'polyline': svgWrap,
        'radialGradient': svgWrap,
        'rect': svgWrap,
        'stop': svgWrap,
        'text': svgWrap
      };
      
      /**
       * Gets the markup wrap configuration for the supplied `nodeName`.
       *
       * NOTE: This lazily detects which wraps are necessary for the current browser.
       *
       * @param {string} nodeName Lowercase `nodeName`.
       * @return {?array} Markup wrap configuration, if applicable.
       */
      function getMarkupWrap(nodeName) {
        ("production" !== "development" ? invariant(!!dummyNode, 'Markup wrapping node not initialized') : invariant(!!dummyNode));
        if (!markupWrap.hasOwnProperty(nodeName)) {
          nodeName = '*';
        }
        if (!shouldWrap.hasOwnProperty(nodeName)) {
          if (nodeName === '*') {
            dummyNode.innerHTML = '<link />';
          } else {
            dummyNode.innerHTML = '<' + nodeName + '></' + nodeName + '>';
          }
          shouldWrap[nodeName] = !dummyNode.firstChild;
        }
        return shouldWrap[nodeName] ? markupWrap[nodeName] : null;
      }
      
      
      module.exports = getMarkupWrap;
      
      },{"./ExecutionEnvironment":21,"./invariant":120}],113:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule getNodeForCharacterOffset
       */
      
      "use strict";
      
      /**
       * Given any node return the first leaf node without children.
       *
       * @param {DOMElement|DOMTextNode} node
       * @return {DOMElement|DOMTextNode}
       */
      function getLeafNode(node) {
        while (node && node.firstChild) {
          node = node.firstChild;
        }
        return node;
      }
      
      /**
       * Get the next sibling within a container. This will walk up the
       * DOM if a node's siblings have been exhausted.
       *
       * @param {DOMElement|DOMTextNode} node
       * @return {?DOMElement|DOMTextNode}
       */
      function getSiblingNode(node) {
        while (node) {
          if (node.nextSibling) {
            return node.nextSibling;
          }
          node = node.parentNode;
        }
      }
      
      /**
       * Get object describing the nodes which contain characters at offset.
       *
       * @param {DOMElement|DOMTextNode} root
       * @param {number} offset
       * @return {?object}
       */
      function getNodeForCharacterOffset(root, offset) {
        var node = getLeafNode(root);
        var nodeStart = 0;
        var nodeEnd = 0;
      
        while (node) {
          if (node.nodeType == 3) {
            nodeEnd = nodeStart + node.textContent.length;
      
            if (nodeStart <= offset && nodeEnd >= offset) {
              return {
                node: node,
                offset: offset - nodeStart
              };
            }
      
            nodeStart = nodeEnd;
          }
      
          node = getLeafNode(getSiblingNode(node));
        }
      }
      
      module.exports = getNodeForCharacterOffset;
      
      },{}],114:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule getReactRootElementInContainer
       */
      
      "use strict";
      
      var DOC_NODE_TYPE = 9;
      
      /**
       * @param {DOMElement|DOMDocument} container DOM element that may contain
       *                                           a React component
       * @return {?*} DOM element that may have the reactRoot ID, or null.
       */
      function getReactRootElementInContainer(container) {
        if (!container) {
          return null;
        }
      
        if (container.nodeType === DOC_NODE_TYPE) {
          return container.documentElement;
        } else {
          return container.firstChild;
        }
      }
      
      module.exports = getReactRootElementInContainer;
      
      },{}],115:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule getTextContentAccessor
       */
      
      "use strict";
      
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      
      var contentKey = null;
      
      /**
       * Gets the key used to access text content on a DOM node.
       *
       * @return {?string} Key used to access text content.
       * @internal
       */
      function getTextContentAccessor() {
        if (!contentKey && ExecutionEnvironment.canUseDOM) {
          // Prefer textContent to innerText because many browsers support both but
          // SVG <text> elements don't support innerText even when <div> does.
          contentKey = 'textContent' in document.documentElement ?
            'textContent' :
            'innerText';
        }
        return contentKey;
      }
      
      module.exports = getTextContentAccessor;
      
      },{"./ExecutionEnvironment":21}],116:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule getUnboundedScrollPosition
       * @typechecks
       */
      
      "use strict";
      
      /**
       * Gets the scroll position of the supplied element or window.
       *
       * The return values are unbounded, unlike `getScrollPosition`. This means they
       * may be negative or exceed the element boundaries (which is possible using
       * inertial scrolling).
       *
       * @param {DOMWindow|DOMElement} scrollable
       * @return {object} Map with `x` and `y` keys.
       */
      function getUnboundedScrollPosition(scrollable) {
        if (scrollable === window) {
          return {
            x: window.pageXOffset || document.documentElement.scrollLeft,
            y: window.pageYOffset || document.documentElement.scrollTop
          };
        }
        return {
          x: scrollable.scrollLeft,
          y: scrollable.scrollTop
        };
      }
      
      module.exports = getUnboundedScrollPosition;
      
      },{}],117:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule hyphenate
       * @typechecks
       */
      
      var _uppercasePattern = /([A-Z])/g;
      
      /**
       * Hyphenates a camelcased string, for example:
       *
       *   > hyphenate('backgroundColor')
       *   < "background-color"
       *
       * For CSS style names, use `hyphenateStyleName` instead which works properly
       * with all vendor prefixes, including `ms`.
       *
       * @param {string} string
       * @return {string}
       */
      function hyphenate(string) {
        return string.replace(_uppercasePattern, '-$1').toLowerCase();
      }
      
      module.exports = hyphenate;
      
      },{}],118:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule hyphenateStyleName
       * @typechecks
       */
      
      "use strict";
      
      var hyphenate = _dereq_("./hyphenate");
      
      var msPattern = /^ms-/;
      
      /**
       * Hyphenates a camelcased CSS property name, for example:
       *
       *   > hyphenate('backgroundColor')
       *   < "background-color"
       *   > hyphenate('MozTransition')
       *   < "-moz-transition"
       *   > hyphenate('msTransition')
       *   < "-ms-transition"
       *
       * As Modernizr suggests (http://modernizr.com/docs/#prefixed), an `ms` prefix
       * is converted to `-ms-`.
       *
       * @param {string} string
       * @return {string}
       */
      function hyphenateStyleName(string) {
        return hyphenate(string).replace(msPattern, '-ms-');
      }
      
      module.exports = hyphenateStyleName;
      
      },{"./hyphenate":117}],119:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule instantiateReactComponent
       * @typechecks static-only
       */
      
      "use strict";
      
      var invariant = _dereq_("./invariant");
      
      /**
       * Validate a `componentDescriptor`. This should be exposed publicly in a follow
       * up diff.
       *
       * @param {object} descriptor
       * @return {boolean} Returns true if this is a valid descriptor of a Component.
       */
      function isValidComponentDescriptor(descriptor) {
        return (
          descriptor &&
          typeof descriptor.type === 'function' &&
          typeof descriptor.type.prototype.mountComponent === 'function' &&
          typeof descriptor.type.prototype.receiveComponent === 'function'
        );
      }
      
      /**
       * Given a `componentDescriptor` create an instance that will actually be
       * mounted. Currently it just extracts an existing clone from composite
       * components but this is an implementation detail which will change.
       *
       * @param {object} descriptor
       * @return {object} A new instance of componentDescriptor's constructor.
       * @protected
       */
      function instantiateReactComponent(descriptor) {
      
        // TODO: Make warning
        // if (__DEV__) {
          ("production" !== "development" ? invariant(
            isValidComponentDescriptor(descriptor),
            'Only React Components are valid for mounting.'
          ) : invariant(isValidComponentDescriptor(descriptor)));
        // }
      
        return new descriptor.type(descriptor);
      }
      
      module.exports = instantiateReactComponent;
      
      },{"./invariant":120}],120:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule invariant
       */
      
      "use strict";
      
      /**
       * Use invariant() to assert state which your program assumes to be true.
       *
       * Provide sprintf-style format (only %s is supported) and arguments
       * to provide information about what broke and what you were
       * expecting.
       *
       * The invariant message will be stripped in production, but the invariant
       * will remain to ensure logic does not differ in production.
       */
      
      var invariant = function(condition, format, a, b, c, d, e, f) {
        if ("production" !== "development") {
          if (format === undefined) {
            throw new Error('invariant requires an error message argument');
          }
        }
      
        if (!condition) {
          var error;
          if (format === undefined) {
            error = new Error(
              'Minified exception occurred; use the non-minified dev environment ' +
              'for the full error message and additional helpful warnings.'
            );
          } else {
            var args = [a, b, c, d, e, f];
            var argIndex = 0;
            error = new Error(
              'Invariant Violation: ' +
              format.replace(/%s/g, function() { return args[argIndex++]; })
            );
          }
      
          error.framesToPop = 1; // we don't care about invariant's own frame
          throw error;
        }
      };
      
      module.exports = invariant;
      
      },{}],121:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule isEventSupported
       */
      
      "use strict";
      
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      
      var useHasFeature;
      if (ExecutionEnvironment.canUseDOM) {
        useHasFeature =
          document.implementation &&
          document.implementation.hasFeature &&
          // always returns true in newer browsers as per the standard.
          // @see http://dom.spec.whatwg.org/#dom-domimplementation-hasfeature
          document.implementation.hasFeature('', '') !== true;
      }
      
      /**
       * Checks if an event is supported in the current execution environment.
       *
       * NOTE: This will not work correctly for non-generic events such as `change`,
       * `reset`, `load`, `error`, and `select`.
       *
       * Borrows from Modernizr.
       *
       * @param {string} eventNameSuffix Event name, e.g. "click".
       * @param {?boolean} capture Check if the capture phase is supported.
       * @return {boolean} True if the event is supported.
       * @internal
       * @license Modernizr 3.0.0pre (Custom Build) | MIT
       */
      function isEventSupported(eventNameSuffix, capture) {
        if (!ExecutionEnvironment.canUseDOM ||
            capture && !('addEventListener' in document)) {
          return false;
        }
      
        var eventName = 'on' + eventNameSuffix;
        var isSupported = eventName in document;
      
        if (!isSupported) {
          var element = document.createElement('div');
          element.setAttribute(eventName, 'return;');
          isSupported = typeof element[eventName] === 'function';
        }
      
        if (!isSupported && useHasFeature && eventNameSuffix === 'wheel') {
          // This is the only way to test support for the `wheel` event in IE9+.
          isSupported = document.implementation.hasFeature('Events.wheel', '3.0');
        }
      
        return isSupported;
      }
      
      module.exports = isEventSupported;
      
      },{"./ExecutionEnvironment":21}],122:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule isNode
       * @typechecks
       */
      
      /**
       * @param {*} object The object to check.
       * @return {boolean} Whether or not the object is a DOM node.
       */
      function isNode(object) {
        return !!(object && (
          typeof Node === 'function' ? object instanceof Node :
            typeof object === 'object' &&
            typeof object.nodeType === 'number' &&
            typeof object.nodeName === 'string'
        ));
      }
      
      module.exports = isNode;
      
      },{}],123:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule isTextInputElement
       */
      
      "use strict";
      
      /**
       * @see http://www.whatwg.org/specs/web-apps/current-work/multipage/the-input-element.html#input-type-attr-summary
       */
      var supportedInputTypes = {
        'color': true,
        'date': true,
        'datetime': true,
        'datetime-local': true,
        'email': true,
        'month': true,
        'number': true,
        'password': true,
        'range': true,
        'search': true,
        'tel': true,
        'text': true,
        'time': true,
        'url': true,
        'week': true
      };
      
      function isTextInputElement(elem) {
        return elem && (
          (elem.nodeName === 'INPUT' && supportedInputTypes[elem.type]) ||
          elem.nodeName === 'TEXTAREA'
        );
      }
      
      module.exports = isTextInputElement;
      
      },{}],124:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule isTextNode
       * @typechecks
       */
      
      var isNode = _dereq_("./isNode");
      
      /**
       * @param {*} object The object to check.
       * @return {boolean} Whether or not the object is a DOM text node.
       */
      function isTextNode(object) {
        return isNode(object) && object.nodeType == 3;
      }
      
      module.exports = isTextNode;
      
      },{"./isNode":122}],125:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule joinClasses
       * @typechecks static-only
       */
      
      "use strict";
      
      /**
       * Combines multiple className strings into one.
       * http://jsperf.com/joinclasses-args-vs-array
       *
       * @param {...?string} classes
       * @return {string}
       */
      function joinClasses(className/*, ... */) {
        if (!className) {
          className = '';
        }
        var nextClass;
        var argLength = arguments.length;
        if (argLength > 1) {
          for (var ii = 1; ii < argLength; ii++) {
            nextClass = arguments[ii];
            nextClass && (className += ' ' + nextClass);
          }
        }
        return className;
      }
      
      module.exports = joinClasses;
      
      },{}],126:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule keyMirror
       * @typechecks static-only
       */
      
      "use strict";
      
      var invariant = _dereq_("./invariant");
      
      /**
       * Constructs an enumeration with keys equal to their value.
       *
       * For example:
       *
       *   var COLORS = keyMirror({blue: null, red: null});
       *   var myColor = COLORS.blue;
       *   var isColorValid = !!COLORS[myColor];
       *
       * The last line could not be performed if the values of the generated enum were
       * not equal to their keys.
       *
       *   Input:  {key1: val1, key2: val2}
       *   Output: {key1: key1, key2: key2}
       *
       * @param {object} obj
       * @return {object}
       */
      var keyMirror = function(obj) {
        var ret = {};
        var key;
        ("production" !== "development" ? invariant(
          obj instanceof Object && !Array.isArray(obj),
          'keyMirror(...): Argument must be an object.'
        ) : invariant(obj instanceof Object && !Array.isArray(obj)));
        for (key in obj) {
          if (!obj.hasOwnProperty(key)) {
            continue;
          }
          ret[key] = key;
        }
        return ret;
      };
      
      module.exports = keyMirror;
      
      },{"./invariant":120}],127:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule keyOf
       */
      
      /**
       * Allows extraction of a minified key. Let's the build system minify keys
       * without loosing the ability to dynamically use key strings as values
       * themselves. Pass in an object with a single key/val pair and it will return
       * you the string key of that single record. Suppose you want to grab the
       * value for a key 'className' inside of an object. Key/val minification may
       * have aliased that key to be 'xa12'. keyOf({className: null}) will return
       * 'xa12' in that case. Resolve keys you want to use once at startup time, then
       * reuse those resolutions.
       */
      var keyOf = function(oneKeyObj) {
        var key;
        for (key in oneKeyObj) {
          if (!oneKeyObj.hasOwnProperty(key)) {
            continue;
          }
          return key;
        }
        return null;
      };
      
      
      module.exports = keyOf;
      
      },{}],128:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule mapObject
       */
      
      "use strict";
      
      /**
       * For each key/value pair, invokes callback func and constructs a resulting
       * object which contains, for every key in obj, values that are the result of
       * of invoking the function:
       *
       *   func(value, key, iteration)
       *
       * Grepable names:
       *
       *   function objectMap()
       *   function objMap()
       *
       * @param {?object} obj Object to map keys over
       * @param {function} func Invoked for each key/val pair.
       * @param {?*} context
       * @return {?object} Result of mapping or null if obj is falsey
       */
      function mapObject(obj, func, context) {
        if (!obj) {
          return null;
        }
        var i = 0;
        var ret = {};
        for (var key in obj) {
          if (obj.hasOwnProperty(key)) {
            ret[key] = func.call(context, obj[key], key, i++);
          }
        }
        return ret;
      }
      
      module.exports = mapObject;
      
      },{}],129:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule memoizeStringOnly
       * @typechecks static-only
       */
      
      "use strict";
      
      /**
       * Memoizes the return value of a function that accepts one string argument.
       *
       * @param {function} callback
       * @return {function}
       */
      function memoizeStringOnly(callback) {
        var cache = {};
        return function(string) {
          if (cache.hasOwnProperty(string)) {
            return cache[string];
          } else {
            return cache[string] = callback.call(this, string);
          }
        };
      }
      
      module.exports = memoizeStringOnly;
      
      },{}],130:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule merge
       */
      
      "use strict";
      
      var mergeInto = _dereq_("./mergeInto");
      
      /**
       * Shallow merges two structures into a return value, without mutating either.
       *
       * @param {?object} one Optional object with properties to merge from.
       * @param {?object} two Optional object with properties to merge from.
       * @return {object} The shallow extension of one by two.
       */
      var merge = function(one, two) {
        var result = {};
        mergeInto(result, one);
        mergeInto(result, two);
        return result;
      };
      
      module.exports = merge;
      
      },{"./mergeInto":132}],131:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule mergeHelpers
       *
       * requiresPolyfills: Array.isArray
       */
      
      "use strict";
      
      var invariant = _dereq_("./invariant");
      var keyMirror = _dereq_("./keyMirror");
      
      /**
       * Maximum number of levels to traverse. Will catch circular structures.
       * @const
       */
      var MAX_MERGE_DEPTH = 36;
      
      /**
       * We won't worry about edge cases like new String('x') or new Boolean(true).
       * Functions are considered terminals, and arrays are not.
       * @param {*} o The item/object/value to test.
       * @return {boolean} true iff the argument is a terminal.
       */
      var isTerminal = function(o) {
        return typeof o !== 'object' || o === null;
      };
      
      var mergeHelpers = {
      
        MAX_MERGE_DEPTH: MAX_MERGE_DEPTH,
      
        isTerminal: isTerminal,
      
        /**
         * Converts null/undefined values into empty object.
         *
         * @param {?Object=} arg Argument to be normalized (nullable optional)
         * @return {!Object}
         */
        normalizeMergeArg: function(arg) {
          return arg === undefined || arg === null ? {} : arg;
        },
      
        /**
         * If merging Arrays, a merge strategy *must* be supplied. If not, it is
         * likely the caller's fault. If this function is ever called with anything
         * but `one` and `two` being `Array`s, it is the fault of the merge utilities.
         *
         * @param {*} one Array to merge into.
         * @param {*} two Array to merge from.
         */
        checkMergeArrayArgs: function(one, two) {
          ("production" !== "development" ? invariant(
            Array.isArray(one) && Array.isArray(two),
            'Tried to merge arrays, instead got %s and %s.',
            one,
            two
          ) : invariant(Array.isArray(one) && Array.isArray(two)));
        },
      
        /**
         * @param {*} one Object to merge into.
         * @param {*} two Object to merge from.
         */
        checkMergeObjectArgs: function(one, two) {
          mergeHelpers.checkMergeObjectArg(one);
          mergeHelpers.checkMergeObjectArg(two);
        },
      
        /**
         * @param {*} arg
         */
        checkMergeObjectArg: function(arg) {
          ("production" !== "development" ? invariant(
            !isTerminal(arg) && !Array.isArray(arg),
            'Tried to merge an object, instead got %s.',
            arg
          ) : invariant(!isTerminal(arg) && !Array.isArray(arg)));
        },
      
        /**
         * @param {*} arg
         */
        checkMergeIntoObjectArg: function(arg) {
          ("production" !== "development" ? invariant(
            (!isTerminal(arg) || typeof arg === 'function') && !Array.isArray(arg),
            'Tried to merge into an object, instead got %s.',
            arg
          ) : invariant((!isTerminal(arg) || typeof arg === 'function') && !Array.isArray(arg)));
        },
      
        /**
         * Checks that a merge was not given a circular object or an object that had
         * too great of depth.
         *
         * @param {number} Level of recursion to validate against maximum.
         */
        checkMergeLevel: function(level) {
          ("production" !== "development" ? invariant(
            level < MAX_MERGE_DEPTH,
            'Maximum deep merge depth exceeded. You may be attempting to merge ' +
            'circular structures in an unsupported way.'
          ) : invariant(level < MAX_MERGE_DEPTH));
        },
      
        /**
         * Checks that the supplied merge strategy is valid.
         *
         * @param {string} Array merge strategy.
         */
        checkArrayStrategy: function(strategy) {
          ("production" !== "development" ? invariant(
            strategy === undefined || strategy in mergeHelpers.ArrayStrategies,
            'You must provide an array strategy to deep merge functions to ' +
            'instruct the deep merge how to resolve merging two arrays.'
          ) : invariant(strategy === undefined || strategy in mergeHelpers.ArrayStrategies));
        },
      
        /**
         * Set of possible behaviors of merge algorithms when encountering two Arrays
         * that must be merged together.
         * - `clobber`: The left `Array` is ignored.
         * - `indexByIndex`: The result is achieved by recursively deep merging at
         *   each index. (not yet supported.)
         */
        ArrayStrategies: keyMirror({
          Clobber: true,
          IndexByIndex: true
        })
      
      };
      
      module.exports = mergeHelpers;
      
      },{"./invariant":120,"./keyMirror":126}],132:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule mergeInto
       * @typechecks static-only
       */
      
      "use strict";
      
      var mergeHelpers = _dereq_("./mergeHelpers");
      
      var checkMergeObjectArg = mergeHelpers.checkMergeObjectArg;
      var checkMergeIntoObjectArg = mergeHelpers.checkMergeIntoObjectArg;
      
      /**
       * Shallow merges two structures by mutating the first parameter.
       *
       * @param {object|function} one Object to be merged into.
       * @param {?object} two Optional object with properties to merge from.
       */
      function mergeInto(one, two) {
        checkMergeIntoObjectArg(one);
        if (two != null) {
          checkMergeObjectArg(two);
          for (var key in two) {
            if (!two.hasOwnProperty(key)) {
              continue;
            }
            one[key] = two[key];
          }
        }
      }
      
      module.exports = mergeInto;
      
      },{"./mergeHelpers":131}],133:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule mixInto
       */
      
      "use strict";
      
      /**
       * Simply copies properties to the prototype.
       */
      var mixInto = function(constructor, methodBag) {
        var methodName;
        for (methodName in methodBag) {
          if (!methodBag.hasOwnProperty(methodName)) {
            continue;
          }
          constructor.prototype[methodName] = methodBag[methodName];
        }
      };
      
      module.exports = mixInto;
      
      },{}],134:[function(_dereq_,module,exports){
      /**
       * Copyright 2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule monitorCodeUse
       */
      
      "use strict";
      
      var invariant = _dereq_("./invariant");
      
      /**
       * Provides open-source compatible instrumentation for monitoring certain API
       * uses before we're ready to issue a warning or refactor. It accepts an event
       * name which may only contain the characters [a-z0-9_] and an optional data
       * object with further information.
       */
      
      function monitorCodeUse(eventName, data) {
        ("production" !== "development" ? invariant(
          eventName && !/[^a-z0-9_]/.test(eventName),
          'You must provide an eventName using only the characters [a-z0-9_]'
        ) : invariant(eventName && !/[^a-z0-9_]/.test(eventName)));
      }
      
      module.exports = monitorCodeUse;
      
      },{"./invariant":120}],135:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule onlyChild
       */
      "use strict";
      
      var ReactDescriptor = _dereq_("./ReactDescriptor");
      
      var invariant = _dereq_("./invariant");
      
      /**
       * Returns the first child in a collection of children and verifies that there
       * is only one child in the collection. The current implementation of this
       * function assumes that a single child gets passed without a wrapper, but the
       * purpose of this helper function is to abstract away the particular structure
       * of children.
       *
       * @param {?object} children Child collection structure.
       * @return {ReactComponent} The first and only `ReactComponent` contained in the
       * structure.
       */
      function onlyChild(children) {
        ("production" !== "development" ? invariant(
          ReactDescriptor.isValidDescriptor(children),
          'onlyChild must be passed a children with exactly one child.'
        ) : invariant(ReactDescriptor.isValidDescriptor(children)));
        return children;
      }
      
      module.exports = onlyChild;
      
      },{"./ReactDescriptor":51,"./invariant":120}],136:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule performance
       * @typechecks
       */
      
      "use strict";
      
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      
      var performance;
      
      if (ExecutionEnvironment.canUseDOM) {
        performance =
          window.performance ||
          window.msPerformance ||
          window.webkitPerformance;
      }
      
      module.exports = performance || {};
      
      },{"./ExecutionEnvironment":21}],137:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule performanceNow
       * @typechecks
       */
      
      var performance = _dereq_("./performance");
      
      /**
       * Detect if we can use `window.performance.now()` and gracefully fallback to
       * `Date.now()` if it doesn't exist. We need to support Firefox < 15 for now
       * because of Facebook's testing infrastructure.
       */
      if (!performance || !performance.now) {
        performance = Date;
      }
      
      var performanceNow = performance.now.bind(performance);
      
      module.exports = performanceNow;
      
      },{"./performance":136}],138:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule setInnerHTML
       */
      
      "use strict";
      
      var ExecutionEnvironment = _dereq_("./ExecutionEnvironment");
      
      /**
       * Set the innerHTML property of a node, ensuring that whitespace is preserved
       * even in IE8.
       *
       * @param {DOMElement} node
       * @param {string} html
       * @internal
       */
      var setInnerHTML = function(node, html) {
        node.innerHTML = html;
      };
      
      if (ExecutionEnvironment.canUseDOM) {
        // IE8: When updating a just created node with innerHTML only leading
        // whitespace is removed. When updating an existing node with innerHTML
        // whitespace in root TextNodes is also collapsed.
        // @see quirksmode.org/bugreports/archives/2004/11/innerhtml_and_t.html
      
        // Feature detection; only IE8 is known to behave improperly like this.
        var testElement = document.createElement('div');
        testElement.innerHTML = ' ';
        if (testElement.innerHTML === '') {
          setInnerHTML = function(node, html) {
            // Magic theory: IE8 supposedly differentiates between added and updated
            // nodes when processing innerHTML, innerHTML on updated nodes suffers
            // from worse whitespace behavior. Re-adding a node like this triggers
            // the initial and more favorable whitespace behavior.
            // TODO: What to do on a detached node?
            if (node.parentNode) {
              node.parentNode.replaceChild(node, node);
            }
      
            // We also implement a workaround for non-visible tags disappearing into
            // thin air on IE8, this only happens if there is no visible text
            // in-front of the non-visible tags. Piggyback on the whitespace fix
            // and simply check if any non-visible tags appear in the source.
            if (html.match(/^[ \r\n\t\f]/) ||
                html[0] === '<' && (
                  html.indexOf('<noscript') !== -1 ||
                  html.indexOf('<script') !== -1 ||
                  html.indexOf('<style') !== -1 ||
                  html.indexOf('<meta') !== -1 ||
                  html.indexOf('<link') !== -1)) {
              // Recover leading whitespace by temporarily prepending any character.
              // \uFEFF has the potential advantage of being zero-width/invisible.
              node.innerHTML = '\uFEFF' + html;
      
              // deleteData leaves an empty `TextNode` which offsets the index of all
              // children. Definitely want to avoid this.
              var textNode = node.firstChild;
              if (textNode.data.length === 1) {
                node.removeChild(textNode);
              } else {
                textNode.deleteData(0, 1);
              }
            } else {
              node.innerHTML = html;
            }
          };
        }
      }
      
      module.exports = setInnerHTML;
      
      },{"./ExecutionEnvironment":21}],139:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule shallowEqual
       */
      
      "use strict";
      
      /**
       * Performs equality by iterating through keys on an object and returning
       * false when any key has values which are not strictly equal between
       * objA and objB. Returns true when the values of all keys are strictly equal.
       *
       * @return {boolean}
       */
      function shallowEqual(objA, objB) {
        if (objA === objB) {
          return true;
        }
        var key;
        // Test for A's keys different from B.
        for (key in objA) {
          if (objA.hasOwnProperty(key) &&
              (!objB.hasOwnProperty(key) || objA[key] !== objB[key])) {
            return false;
          }
        }
        // Test for B'a keys missing from A.
        for (key in objB) {
          if (objB.hasOwnProperty(key) && !objA.hasOwnProperty(key)) {
            return false;
          }
        }
        return true;
      }
      
      module.exports = shallowEqual;
      
      },{}],140:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule shouldUpdateReactComponent
       * @typechecks static-only
       */
      
      "use strict";
      
      /**
       * Given a `prevDescriptor` and `nextDescriptor`, determines if the existing
       * instance should be updated as opposed to being destroyed or replaced by a new
       * instance. Both arguments are descriptors. This ensures that this logic can
       * operate on stateless trees without any backing instance.
       *
       * @param {?object} prevDescriptor
       * @param {?object} nextDescriptor
       * @return {boolean} True if the existing instance should be updated.
       * @protected
       */
      function shouldUpdateReactComponent(prevDescriptor, nextDescriptor) {
        if (prevDescriptor && nextDescriptor &&
            prevDescriptor.type === nextDescriptor.type && (
              (prevDescriptor.props && prevDescriptor.props.key) ===
              (nextDescriptor.props && nextDescriptor.props.key)
            ) && prevDescriptor._owner === nextDescriptor._owner) {
          return true;
        }
        return false;
      }
      
      module.exports = shouldUpdateReactComponent;
      
      },{}],141:[function(_dereq_,module,exports){
      /**
       * Copyright 2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule toArray
       * @typechecks
       */
      
      var invariant = _dereq_("./invariant");
      
      /**
       * Convert array-like objects to arrays.
       *
       * This API assumes the caller knows the contents of the data type. For less
       * well defined inputs use createArrayFrom.
       *
       * @param {object|function|filelist} obj
       * @return {array}
       */
      function toArray(obj) {
        var length = obj.length;
      
        // Some browse builtin objects can report typeof 'function' (e.g. NodeList in
        // old versions of Safari).
        ("production" !== "development" ? invariant(
          !Array.isArray(obj) &&
          (typeof obj === 'object' || typeof obj === 'function'),
          'toArray: Array-like object expected'
        ) : invariant(!Array.isArray(obj) &&
        (typeof obj === 'object' || typeof obj === 'function')));
      
        ("production" !== "development" ? invariant(
          typeof length === 'number',
          'toArray: Object needs a length property'
        ) : invariant(typeof length === 'number'));
      
        ("production" !== "development" ? invariant(
          length === 0 ||
          (length - 1) in obj,
          'toArray: Object should have keys for indices'
        ) : invariant(length === 0 ||
        (length - 1) in obj));
      
        // Old IE doesn't give collections access to hasOwnProperty. Assume inputs
        // without method will throw during the slice call and skip straight to the
        // fallback.
        if (obj.hasOwnProperty) {
          try {
            return Array.prototype.slice.call(obj);
          } catch (e) {
            // IE < 9 does not support Array#slice on collections objects
          }
        }
      
        // Fall back to copying key by key. This assumes all keys have a value,
        // so will not preserve sparsely populated inputs.
        var ret = Array(length);
        for (var ii = 0; ii < length; ii++) {
          ret[ii] = obj[ii];
        }
        return ret;
      }
      
      module.exports = toArray;
      
      },{"./invariant":120}],142:[function(_dereq_,module,exports){
      /**
       * Copyright 2013-2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule traverseAllChildren
       */
      
      "use strict";
      
      var ReactInstanceHandles = _dereq_("./ReactInstanceHandles");
      var ReactTextComponent = _dereq_("./ReactTextComponent");
      
      var invariant = _dereq_("./invariant");
      
      var SEPARATOR = ReactInstanceHandles.SEPARATOR;
      var SUBSEPARATOR = ':';
      
      /**
       * TODO: Test that:
       * 1. `mapChildren` transforms strings and numbers into `ReactTextComponent`.
       * 2. it('should fail when supplied duplicate key', function() {
       * 3. That a single child and an array with one item have the same key pattern.
       * });
       */
      
      var userProvidedKeyEscaperLookup = {
        '=': '=0',
        '.': '=1',
        ':': '=2'
      };
      
      var userProvidedKeyEscapeRegex = /[=.:]/g;
      
      function userProvidedKeyEscaper(match) {
        return userProvidedKeyEscaperLookup[match];
      }
      
      /**
       * Generate a key string that identifies a component within a set.
       *
       * @param {*} component A component that could contain a manual key.
       * @param {number} index Index that is used if a manual key is not provided.
       * @return {string}
       */
      function getComponentKey(component, index) {
        if (component && component.props && component.props.key != null) {
          // Explicit key
          return wrapUserProvidedKey(component.props.key);
        }
        // Implicit key determined by the index in the set
        return index.toString(36);
      }
      
      /**
       * Escape a component key so that it is safe to use in a reactid.
       *
       * @param {*} key Component key to be escaped.
       * @return {string} An escaped string.
       */
      function escapeUserProvidedKey(text) {
        return ('' + text).replace(
          userProvidedKeyEscapeRegex,
          userProvidedKeyEscaper
        );
      }
      
      /**
       * Wrap a `key` value explicitly provided by the user to distinguish it from
       * implicitly-generated keys generated by a component's index in its parent.
       *
       * @param {string} key Value of a user-provided `key` attribute
       * @return {string}
       */
      function wrapUserProvidedKey(key) {
        return '$' + escapeUserProvidedKey(key);
      }
      
      /**
       * @param {?*} children Children tree container.
       * @param {!string} nameSoFar Name of the key path so far.
       * @param {!number} indexSoFar Number of children encountered until this point.
       * @param {!function} callback Callback to invoke with each child found.
       * @param {?*} traverseContext Used to pass information throughout the traversal
       * process.
       * @return {!number} The number of children in this subtree.
       */
      var traverseAllChildrenImpl =
        function(children, nameSoFar, indexSoFar, callback, traverseContext) {
          var subtreeCount = 0;  // Count of children found in the current subtree.
          if (Array.isArray(children)) {
            for (var i = 0; i < children.length; i++) {
              var child = children[i];
              var nextName = (
                nameSoFar +
                (nameSoFar ? SUBSEPARATOR : SEPARATOR) +
                getComponentKey(child, i)
              );
              var nextIndex = indexSoFar + subtreeCount;
              subtreeCount += traverseAllChildrenImpl(
                child,
                nextName,
                nextIndex,
                callback,
                traverseContext
              );
            }
          } else {
            var type = typeof children;
            var isOnlyChild = nameSoFar === '';
            // If it's the only child, treat the name as if it was wrapped in an array
            // so that it's consistent if the number of children grows
            var storageName =
              isOnlyChild ? SEPARATOR + getComponentKey(children, 0) : nameSoFar;
            if (children == null || type === 'boolean') {
              // All of the above are perceived as null.
              callback(traverseContext, null, storageName, indexSoFar);
              subtreeCount = 1;
            } else if (children.type && children.type.prototype &&
                       children.type.prototype.mountComponentIntoNode) {
              callback(traverseContext, children, storageName, indexSoFar);
              subtreeCount = 1;
            } else {
              if (type === 'object') {
                ("production" !== "development" ? invariant(
                  !children || children.nodeType !== 1,
                  'traverseAllChildren(...): Encountered an invalid child; DOM ' +
                  'elements are not valid children of React components.'
                ) : invariant(!children || children.nodeType !== 1));
                for (var key in children) {
                  if (children.hasOwnProperty(key)) {
                    subtreeCount += traverseAllChildrenImpl(
                      children[key],
                      (
                        nameSoFar + (nameSoFar ? SUBSEPARATOR : SEPARATOR) +
                        wrapUserProvidedKey(key) + SUBSEPARATOR +
                        getComponentKey(children[key], 0)
                      ),
                      indexSoFar + subtreeCount,
                      callback,
                      traverseContext
                    );
                  }
                }
              } else if (type === 'string') {
                var normalizedText = ReactTextComponent(children);
                callback(traverseContext, normalizedText, storageName, indexSoFar);
                subtreeCount += 1;
              } else if (type === 'number') {
                var normalizedNumber = ReactTextComponent('' + children);
                callback(traverseContext, normalizedNumber, storageName, indexSoFar);
                subtreeCount += 1;
              }
            }
          }
          return subtreeCount;
        };
      
      /**
       * Traverses children that are typically specified as `props.children`, but
       * might also be specified through attributes:
       *
       * - `traverseAllChildren(this.props.children, ...)`
       * - `traverseAllChildren(this.props.leftPanelChildren, ...)`
       *
       * The `traverseContext` is an optional argument that is passed through the
       * entire traversal. It can be used to store accumulations or anything else that
       * the callback might find relevant.
       *
       * @param {?*} children Children tree object.
       * @param {!function} callback To invoke upon traversing each child.
       * @param {?*} traverseContext Context for traversal.
       * @return {!number} The number of children in this subtree.
       */
      function traverseAllChildren(children, callback, traverseContext) {
        if (children == null) {
          return 0;
        }
      
        return traverseAllChildrenImpl(children, '', 0, callback, traverseContext);
      }
      
      module.exports = traverseAllChildren;
      
      },{"./ReactInstanceHandles":59,"./ReactTextComponent":75,"./invariant":120}],143:[function(_dereq_,module,exports){
      /**
       * Copyright 2014 Facebook, Inc.
       *
       * Licensed under the Apache License, Version 2.0 (the "License");
       * you may not use this file except in compliance with the License.
       * You may obtain a copy of the License at
       *
       * http://www.apache.org/licenses/LICENSE-2.0
       *
       * Unless required by applicable law or agreed to in writing, software
       * distributed under the License is distributed on an "AS IS" BASIS,
       * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
       * See the License for the specific language governing permissions and
       * limitations under the License.
       *
       * @providesModule warning
       */
      
      "use strict";
      
      var emptyFunction = _dereq_("./emptyFunction");
      
      /**
       * Similar to invariant but only logs a warning if the condition is not met.
       * This can be used to log issues in development environments in critical
       * paths. Removing the logging code for production environments will keep the
       * same logic and follow the same code paths.
       */
      
      var warning = emptyFunction;
      
      if ("production" !== "development") {
        warning = function(condition, format ) {var args=Array.prototype.slice.call(arguments,2);
          if (format === undefined) {
            throw new Error(
              '`warning(condition, format, ...args)` requires a warning ' +
              'message argument'
            );
          }
      
          if (!condition) {
            var argIndex = 0;
            console.warn('Warning: ' + format.replace(/%s/g, function()  {return args[argIndex++];}));
          }
        };
      }
      
      module.exports = warning;
      
      },{"./emptyFunction":102}]},{},[27])
      (27)
      });
  }).call(System.global);  return System.get("@@global-helpers").retrieveGlobal(__module.id, false);
});

System.register("github:jspm/nodelibs@0.0.3/process", [], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/github/jspm/nodelibs@0.0.3/process.js";
  var __dirname = "jspm_packages/github/jspm/nodelibs@0.0.3";
  "format cjs";
  function noop() {}
  var process = module.exports = {};
  process.nextTick = function() {
    var e = "undefined" != typeof window && window.setImmediate,
        t = "undefined" != typeof window && window.postMessage && window.addEventListener;
    if (e)
      return function(e) {
        return window.setImmediate(e);
      };
    if (t) {
      var r = [];
      return window.addEventListener("message", function(e) {
        var t = e.source;
        if ((t === window || null === t) && "process-tick" === e.data && (e.stopPropagation(), r.length > 0)) {
          var n = r.shift();
          n();
        }
      }, !0), function(e) {
        r.push(e), window.postMessage("process-tick", "*");
      };
    }
    return function(e) {
      setTimeout(e, 0);
    };
  }(), process.title = "browser", process.browser = !0, process.env = {}, process.argv = [], process.on = noop, process.addListener = noop, process.once = noop, process.off = noop, process.removeListener = noop, process.removeAllListeners = noop, process.emit = noop, process.binding = function() {
    throw new Error("process.binding is not supported");
  }, process.cwd = function() {
    return "/";
  }, process.chdir = function() {
    throw new Error("process.chdir is not supported");
  };
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/components/App", ["github:reactjs/react-bower@0.11.2","npm:react-router@0.7.0"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/components/App.js";
  var __dirname = "build/src/components";
  var React = require("github:reactjs/react-bower@0.11.2");
  var Link = require("npm:react-router@0.7.0").Link;
  var App = module.exports = React.createClass({
    displayName: 'DataGroomerApp',
    render: function() {
      return (React.DOM.div(null, React.DOM.div({className: "container header"}, React.DOM.h1(null, Link({to: "/"}, "DataGroomer"))), React.DOM.div({className: "container content"}, this.props.activeRouteHandler(null))));
    }
  });
  
  global.define = __define;
  return module.exports;
});

System.register("npm:reflux@0.1.12/dist/reflux", [], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/reflux@0.1.12/dist/reflux.js";
  var __dirname = "jspm_packages/npm/reflux@0.1.12/dist";
  "format cjs";
  !function(t) {
    if ("object" == typeof exports && "undefined" != typeof module)
      module.exports = t();
    else if ("function" == typeof define && define.amd)
      define([], t);
    else {
      var e;
      "undefined" != typeof window ? e = window : "undefined" != typeof global ? e = global : "undefined" != typeof self && (e = self), e.Reflux = t();
    }
  }(function() {
    return function t(e, n, i) {
      function s(o, u) {
        if (!n[o]) {
          if (!e[o]) {
            var c = "function" == typeof require && require;
            if (!u && c)
              return c(o, !0);
            if (r)
              return r(o, !0);
            throw new Error("Cannot find module '" + o + "'");
          }
          var a = n[o] = {exports: {}};
          e[o][0].call(a.exports, function(t) {
            var n = e[o][1][t];
            return s(n ? n : t);
          }, a, a.exports, t, e, n, i);
        }
        return n[o].exports;
      }
      for (var r = "function" == typeof require && require,
          o = 0; o < i.length; o++)
        s(i[o]);
      return s;
    }({
      1: [function(t, e) {
        "use strict";
        function n(t, e, n) {
          this.fn = t, this.context = e, this.once = n || !1;
        }
        function i() {}
        i.prototype._events = void 0, i.prototype.listeners = function(t) {
          if (!this._events || !this._events[t])
            return [];
          for (var e = 0,
              n = this._events[t].length,
              i = []; n > e; e++)
            i.push(this._events[t][e].fn);
          return i;
        }, i.prototype.emit = function(t, e, n, i, s, r) {
          if (!this._events || !this._events[t])
            return !1;
          var o,
              u,
              c,
              a = this._events[t],
              l = a.length,
              h = arguments.length,
              f = a[0];
          if (1 === l) {
            switch (f.once && this.removeListener(t, f.fn, !0), h) {
              case 1:
                return f.fn.call(f.context), !0;
              case 2:
                return f.fn.call(f.context, e), !0;
              case 3:
                return f.fn.call(f.context, e, n), !0;
              case 4:
                return f.fn.call(f.context, e, n, i), !0;
              case 5:
                return f.fn.call(f.context, e, n, i, s), !0;
              case 6:
                return f.fn.call(f.context, e, n, i, s, r), !0;
            }
            for (u = 1, o = new Array(h - 1); h > u; u++)
              o[u - 1] = arguments[u];
            f.fn.apply(f.context, o);
          } else
            for (u = 0; l > u; u++)
              switch (a[u].once && this.removeListener(t, a[u].fn, !0), h) {
                case 1:
                  a[u].fn.call(a[u].context);
                  break;
                case 2:
                  a[u].fn.call(a[u].context, e);
                  break;
                case 3:
                  a[u].fn.call(a[u].context, e, n);
                  break;
                default:
                  if (!o)
                    for (c = 1, o = new Array(h - 1); h > c; c++)
                      o[c - 1] = arguments[c];
                  a[u].fn.apply(a[u].context, o);
              }
          return !0;
        }, i.prototype.on = function(t, e, i) {
          return this._events || (this._events = {}), this._events[t] || (this._events[t] = []), this._events[t].push(new n(e, i || this)), this;
        }, i.prototype.once = function(t, e, i) {
          return this._events || (this._events = {}), this._events[t] || (this._events[t] = []), this._events[t].push(new n(e, i || this, !0)), this;
        }, i.prototype.removeListener = function(t, e, n) {
          if (!this._events || !this._events[t])
            return this;
          var i = this._events[t],
              s = [];
          if (e)
            for (var r = 0,
                o = i.length; o > r; r++)
              i[r].fn !== e && i[r].once !== n && s.push(i[r]);
          return this._events[t] = s.length ? s : null, this;
        }, i.prototype.removeAllListeners = function(t) {
          return this._events ? (t ? this._events[t] = null : this._events = {}, this) : this;
        }, i.prototype.off = i.prototype.removeListener, i.prototype.addListener = i.prototype.on, i.prototype.setMaxListeners = function() {
          return this;
        }, i.EventEmitter = i, i.EventEmitter2 = i, i.EventEmitter3 = i, "object" == typeof e && e.exports && (e.exports = i);
      }, {}],
      2: [function(t, e, n) {
        n.createdStores = [], n.createdActions = [], n.reset = function() {
          for (; n.createdStores.length; )
            n.createdStores.pop();
          for (; n.createdActions.length; )
            n.createdActions.pop();
        };
      }, {}],
      3: [function(t, e) {
        var n = t("./utils");
        e.exports = {
          hasListener: function(t) {
            for (var e,
                n = 0; n < (this.subscriptions || []).length; ++n)
              if (e = this.subscriptions[n].listenable, e === t && !t._isAction || e.hasListener && e.hasListener(t))
                return !0;
            return !1;
          },
          listenToMany: function(t) {
            for (var e in t) {
              var i = n.callbackName(e),
                  s = this[i] ? i : this[e] ? e : void 0;
              s && this.listenTo(t[e], s, this[i + "Default"] || this[s + "Default"] || s);
            }
          },
          validateListening: function(t) {
            return t === this ? "Listener is not able to listen to itself" : n.isFunction(t.listen) ? this.hasListener(t) ? "Listener cannot listen to this listenable because of circular loop" : void 0 : t + " is missing a listen method";
          },
          listenTo: function(t, e, n) {
            var i = this.validateListening(t),
                s = this;
            if (i)
              throw Error(i);
            this.fetchDefaultData(t, n), this.subscriptions || (this.subscriptions = []);
            var r = t.listen(this[e] || e, this),
                o = function(e) {
                  r(), e || s.subscriptions.splice(s.subscriptions.indexOf(t), 1);
                },
                u = {
                  stop: o,
                  listenable: t
                };
            return this.subscriptions.push(u), u;
          },
          stopListeningTo: function(t, e) {
            for (var n = 0; n < (this.subscriptions || []).length; n++)
              if (this.subscriptions[n].listenable === t)
                return this.subscriptions[n].stop(e), !0;
            return !1;
          },
          stopListeningToAll: function() {
            (this.subscriptions || []).forEach(function(t) {
              t.stop(!0);
            }), this.subscriptions = [];
          },
          fetchDefaultData: function(t, e) {
            e = e && this[e] || e;
            var i = this;
            n.isFunction(e) && n.isFunction(t.getDefaultData) && (data = t.getDefaultData(), data && n.isFunction(data.then) ? data.then(function() {
              e.apply(i, arguments);
            }) : e.call(this, data));
          }
        };
      }, {"./utils": 13}],
      4: [function(t, e) {
        var n = t("./utils"),
            i = t("./ListenerMethods");
        e.exports = n.extend({componentWillUnmount: i.stopListeningToAll}, i);
      }, {
        "./ListenerMethods": 3,
        "./utils": 13
      }],
      5: [function(t, e) {
        var n = t("./utils");
        e.exports = {
          preEmit: function() {},
          shouldEmit: function() {
            return !0;
          },
          listen: function(t, e) {
            var n = function(n) {
              t.apply(e, n);
            },
                i = this;
            return this.emitter.addListener(this.eventLabel, n), function() {
              i.emitter.removeListener(i.eventLabel, n);
            };
          },
          trigger: function() {
            var t = arguments,
                e = this.preEmit.apply(this, t);
            t = void 0 === e ? t : n.isArguments(e) ? e : [].concat(e), this.shouldEmit.apply(this, t) && this.emitter.emit(this.eventLabel, t);
          },
          triggerAsync: function() {
            var t = arguments,
                e = this;
            n.nextTick(function() {
              e.trigger.apply(e, t);
            });
          }
        };
      }, {"./utils": 13}],
      6: [function(t, e) {
        var n = t("./createAction"),
            i = Array.prototype.slice;
        e.exports = function() {
          function t() {
            o = new Array(c), u = new Array(c);
          }
          function e(t) {
            return function() {
              o[t] = !0, u[t] = i.call(arguments), s();
            };
          }
          function s() {
            r() && (a.apply(a, u), t());
          }
          function r() {
            for (var t = 0; c > t; t++)
              if (!o[t])
                return !1;
            return !0;
          }
          var o,
              u,
              c = arguments.length,
              a = n(),
              l = i.call(arguments);
          a._isAction = !1, a.hasListener = function(t) {
            for (var e,
                n = 0; n < l.length; ++n)
              if (e = l[n], e === t && !e._isAction || e.hasListener && e.hasListener(t))
                return !0;
            return !1;
          }, t();
          for (var h = 0; c > h; h++)
            arguments[h].listen(e(h), null);
          return a;
        };
      }, {"./createAction": 8}],
      7: [function(t, e) {
        var n = t("../src"),
            i = t("./utils");
        e.exports = function(t, e) {
          return {
            componentDidMount: function() {
              for (var s in n.ListenerMethods)
                if (this[s] !== n.ListenerMethods[s]) {
                  if (this[s])
                    throw "Can't have other property '" + s + "' when using Reflux.listenTo!";
                  this[s] = n.ListenerMethods[s];
                }
              var r = this,
                  o = void 0 === e ? this.setState : function(t) {
                    r.setState(i.object([e], [t]));
                  };
              this.listenTo(t, o, o);
            },
            componentWillUnmount: n.ListenerMixin.componentWillUnmount
          };
        };
      }, {
        "../src": 10,
        "./utils": 13
      }],
      8: [function(t, e) {
        var n = t("./utils"),
            i = t("../src"),
            s = t("./Keep");
        e.exports = function(t) {
          t = t || {};
          var e = n.extend({
            eventLabel: "action",
            emitter: new n.EventEmitter,
            _isAction: !0
          }, t, i.PublisherMethods, {
            preEmit: t.preEmit || i.PublisherMethods.preEmit,
            shouldEmit: t.shouldEmit || i.PublisherMethods.shouldEmit
          }),
              r = function() {
                e.triggerAsync.apply(e, arguments);
              };
          return n.extend(r, e), s.createdActions.push(r), r;
        };
      }, {
        "../src": 10,
        "./Keep": 2,
        "./utils": 13
      }],
      9: [function(t, e) {
        var n = t("./utils"),
            i = t("../src"),
            s = t("./Keep");
        e.exports = function(t) {
          function e() {
            var t,
                e = 0;
            if (this.subscriptions = [], this.emitter = new n.EventEmitter, this.eventLabel = "change", this.init && n.isFunction(this.init) && this.init(), this.listenables)
              for (t = [].concat(this.listenables); e < t.length; e++)
                this.listenToMany(t[e]);
          }
          t = t || {}, n.extend(e.prototype, t, i.ListenerMethods, i.PublisherMethods, {
            preEmit: t.preEmit || i.PublisherMethods.preEmit,
            shouldEmit: t.shouldEmit || i.PublisherMethods.shouldEmit
          });
          var r = new e;
          return s.createdStores.push(r), r;
        };
      }, {
        "../src": 10,
        "./Keep": 2,
        "./utils": 13
      }],
      10: [function(t, e, n) {
        n.ListenerMethods = t("./ListenerMethods"), n.PublisherMethods = t("./PublisherMethods"), n.createAction = t("./createAction"), n.createStore = t("./createStore"), n.connect = t("./connect"), n.ListenerMixin = t("./ListenerMixin"), n.listenTo = t("./listenTo"), n.listenToMany = t("./listenToMany"), n.all = t("./all"), n.createActions = function(t) {
          for (var e = 0,
              i = {}; e < t.length; e++)
            i[t[e]] = n.createAction();
          return i;
        }, n.setEventEmitter = function(e) {
          var n = t("./utils");
          n.EventEmitter = e;
        }, n.nextTick = function(e) {
          var n = t("./utils");
          n.nextTick = e;
        }, n.__keep = t("./Keep");
      }, {
        "./Keep": 2,
        "./ListenerMethods": 3,
        "./ListenerMixin": 4,
        "./PublisherMethods": 5,
        "./all": 6,
        "./connect": 7,
        "./createAction": 8,
        "./createStore": 9,
        "./listenTo": 11,
        "./listenToMany": 12,
        "./utils": 13
      }],
      11: [function(t, e) {
        var n = t("../src");
        e.exports = function(t, e, i) {
          return {
            componentDidMount: function() {
              for (var s in n.ListenerMethods)
                if (this[s] !== n.ListenerMethods[s]) {
                  if (this[s])
                    throw "Can't have other property '" + s + "' when using Reflux.listenTo!";
                  this[s] = n.ListenerMethods[s];
                }
              this.listenTo(t, e, i);
            },
            componentWillUnmount: n.ListenerMethods.stopListeningToAll
          };
        };
      }, {"../src": 10}],
      12: [function(t, e) {
        var n = t("../src");
        e.exports = function(t) {
          return {
            componentDidMount: function() {
              for (var e in n.ListenerMethods)
                if (this[e] !== n.ListenerMethods[e]) {
                  if (this[e])
                    throw "Can't have other property '" + e + "' when using Reflux.listenToMany!";
                  this[e] = n.ListenerMethods[e];
                }
              this.listenToMany(t);
            },
            componentWillUnmount: n.ListenerMethods.stopListeningToAll
          };
        };
      }, {"../src": 10}],
      13: [function(t, e, n) {
        var i = n.isObject = function(t) {
          var e = typeof t;
          return "function" === e || "object" === e && !!t;
        };
        n.extend = function(t) {
          if (!i(t))
            return t;
          for (var e,
              n,
              s = 1,
              r = arguments.length; r > s; s++) {
            e = arguments[s];
            for (n in e)
              t[n] = e[n];
          }
          return t;
        }, n.isFunction = function(t) {
          return "function" == typeof t;
        }, n.EventEmitter = t("eventemitter3"), n.nextTick = function(t) {
          setTimeout(t, 0);
        }, n.callbackName = function(t) {
          return "on" + t.charAt(0).toUpperCase() + t.slice(1);
        }, n.object = function(t, e) {
          for (var n = {},
              i = 0; i < t.length; i++)
            n[t[i]] = e[i];
          return n;
        }, n.isArguments = function(t) {
          return t && "object" == typeof t && "number" == typeof t.length && ("[object Arguments]" === toString.call(t) || hasOwnProperty.call(t, "callee" && !propertyIsEnumerable.call(t, "callee"))) || !1;
        };
      }, {eventemitter3: 1}]
    }, {}, [10])(10);
  });
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/compare/compareActions", ["npm:reflux@0.1.12"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/compare/compareActions.js";
  var __dirname = "build/src/compare";
  var Reflux = require("npm:reflux@0.1.12");
  module.exports = Reflux.createActions(['setResults']);
  
  global.define = __define;
  return module.exports;
});

System.register("npm:es6-promise@1.0.0/dist/commonjs/promise/config", [], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise/config.js";
  var __dirname = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise";
  "format cjs";
  "use strict";
  function configure(r, o) {
    return 2 !== arguments.length ? config[r] : void(config[r] = o);
  }
  var config = {instrument: !1};
  exports.config = config, exports.configure = configure;
  
  global.define = __define;
  return module.exports;
});

System.register("npm:es6-promise@1.0.0/dist/commonjs/promise/utils", [], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise/utils.js";
  var __dirname = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise";
  "format cjs";
  "use strict";
  function objectOrFunction(t) {
    return isFunction(t) || "object" == typeof t && null !== t;
  }
  function isFunction(t) {
    return "function" == typeof t;
  }
  function isArray(t) {
    return "[object Array]" === Object.prototype.toString.call(t);
  }
  var now = Date.now || function() {
    return (new Date).getTime();
  };
  exports.objectOrFunction = objectOrFunction, exports.isFunction = isFunction, exports.isArray = isArray, exports.now = now;
  
  global.define = __define;
  return module.exports;
});

System.register("npm:es6-promise@1.0.0/dist/commonjs/promise/all", ["npm:es6-promise@1.0.0/dist/commonjs/promise/utils","npm:es6-promise@1.0.0/dist/commonjs/promise/utils"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise/all.js";
  var __dirname = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise";
  "format cjs";
  "use strict";
  function all(e) {
    var t = this;
    if (!isArray(e))
      throw new TypeError("You must pass an array to all.");
    return new t(function(t, r) {
      function i(e) {
        return function(t) {
          n(e, t);
        };
      }
      function n(e, r) {
        s[e] = r, 0 === --c && t(s);
      }
      var o,
          s = [],
          c = e.length;
      0 === c && t([]);
      for (var u = 0; u < e.length; u++)
        o = e[u], o && isFunction(o.then) ? o.then(i(u), r) : n(u, o);
    });
  }
  var isArray = require("npm:es6-promise@1.0.0/dist/commonjs/promise/utils").isArray,
      isFunction = require("npm:es6-promise@1.0.0/dist/commonjs/promise/utils").isFunction;
  exports.all = all;
  
  global.define = __define;
  return module.exports;
});

System.register("npm:es6-promise@1.0.0/dist/commonjs/promise/race", ["npm:es6-promise@1.0.0/dist/commonjs/promise/utils"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise/race.js";
  var __dirname = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise";
  "format cjs";
  "use strict";
  function race(e) {
    var r = this;
    if (!isArray(e))
      throw new TypeError("You must pass an array to race.");
    return new r(function(r, t) {
      for (var i,
          n = 0; n < e.length; n++)
        i = e[n], i && "function" == typeof i.then ? i.then(r, t) : r(i);
    });
  }
  var isArray = require("npm:es6-promise@1.0.0/dist/commonjs/promise/utils").isArray;
  exports.race = race;
  
  global.define = __define;
  return module.exports;
});

System.register("npm:es6-promise@1.0.0/dist/commonjs/promise/resolve", [], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise/resolve.js";
  var __dirname = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise";
  "format cjs";
  "use strict";
  function resolve(e) {
    if (e && "object" == typeof e && e.constructor === this)
      return e;
    var r = this;
    return new r(function(r) {
      r(e);
    });
  }
  exports.resolve = resolve;
  
  global.define = __define;
  return module.exports;
});

System.register("npm:es6-promise@1.0.0/dist/commonjs/promise/reject", [], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise/reject.js";
  var __dirname = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise";
  "format cjs";
  "use strict";
  function reject(e) {
    var r = this;
    return new r(function(r, t) {
      t(e);
    });
  }
  exports.reject = reject;
  
  global.define = __define;
  return module.exports;
});

System.register("npm:es6-promise@1.0.0/dist/commonjs/promise/asap", ["github:jspm/nodelibs@0.0.3/process"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise/asap.js";
  var __dirname = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise";
  "format cjs";
  !function(e) {
    "use strict";
    function t() {
      return function() {
        e.nextTick(n);
      };
    }
    function r() {
      var e = 0,
          t = new u(n),
          r = document.createTextNode("");
      return t.observe(r, {characterData: !0}), function() {
        r.data = e = ++e % 2;
      };
    }
    function i() {
      return function() {
        l.setTimeout(n, 1);
      };
    }
    function n() {
      for (var e = 0; e < a.length; e++) {
        var t = a[e],
            r = t[0],
            i = t[1];
        r(i);
      }
      a = [];
    }
    function o(e, t) {
      var r = a.push([e, t]);
      1 === r && s();
    }
    var s,
        c = "undefined" != typeof window ? window : {},
        u = c.MutationObserver || c.WebKitMutationObserver,
        l = "undefined" != typeof global ? global : void 0 === this ? window : this,
        a = [];
    s = "undefined" != typeof e && "[object process]" === {}.toString.call(e) ? t() : u ? r() : i(), exports.asap = o;
  }(require("github:jspm/nodelibs@0.0.3/process"));
  
  global.define = __define;
  return module.exports;
});

System.register("npm:es6-promise@1.0.0/dist/commonjs/promise/polyfill", ["npm:es6-promise@1.0.0/dist/commonjs/promise/promise","npm:es6-promise@1.0.0/dist/commonjs/promise/utils"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise/polyfill.js";
  var __dirname = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise";
  "format cjs";
  "use strict";
  function polyfill() {
    var e;
    e = "undefined" != typeof global ? global : "undefined" != typeof window && window.document ? window : self;
    var r = "Promise" in e && "resolve" in e.Promise && "reject" in e.Promise && "all" in e.Promise && "race" in e.Promise && function() {
      var r;
      return new e.Promise(function(e) {
        r = e;
      }), isFunction(r);
    }();
    r || (e.Promise = RSVPPromise);
  }
  var RSVPPromise = require("npm:es6-promise@1.0.0/dist/commonjs/promise/promise").Promise,
      isFunction = require("npm:es6-promise@1.0.0/dist/commonjs/promise/utils").isFunction;
  exports.polyfill = polyfill;
  
  global.define = __define;
  return module.exports;
});

System.register("npm:sentence-case@1.1.0/vendor/non-word-regexp", [], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/sentence-case@1.1.0/vendor/non-word-regexp.js";
  var __dirname = "jspm_packages/npm/sentence-case@1.1.0/vendor";
  "format cjs";
  module.exports = /[^\u0041-\u005A\u0061-\u007A\u00AA\u00B5\u00BA\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u0527\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u08A0\u08A2-\u08AC\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0977\u0979-\u097F\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C33\u0C35-\u0C39\u0C3D\u0C58\u0C59\u0C60\u0C61\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D60\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F4\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191C\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19C1-\u19C7\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2183\u2184\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005\u3006\u3031-\u3035\u303B\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FCC\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA697\uA6A0-\uA6E5\uA717-\uA71F\uA722-\uA788\uA78B-\uA78E\uA790-\uA793\uA7A0-\uA7AA\uA7F8-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA80-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uABC0-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC\u0030-\u0039\u00B2\u00B3\u00B9\u00BC-\u00BE\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u09F4-\u09F9\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0B72-\u0B77\u0BE6-\u0BF2\u0C66-\u0C6F\u0C78-\u0C7E\u0CE6-\u0CEF\u0D66-\u0D75\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F33\u1040-\u1049\u1090-\u1099\u1369-\u137C\u16EE-\u16F0\u17E0-\u17E9\u17F0-\u17F9\u1810-\u1819\u1946-\u194F\u19D0-\u19DA\u1A80-\u1A89\u1A90-\u1A99\u1B50-\u1B59\u1BB0-\u1BB9\u1C40-\u1C49\u1C50-\u1C59\u2070\u2074-\u2079\u2080-\u2089\u2150-\u2182\u2185-\u2189\u2460-\u249B\u24EA-\u24FF\u2776-\u2793\u2CFD\u3007\u3021-\u3029\u3038-\u303A\u3192-\u3195\u3220-\u3229\u3248-\u324F\u3251-\u325F\u3280-\u3289\u32B1-\u32BF\uA620-\uA629\uA6E6-\uA6EF\uA830-\uA835\uA8D0-\uA8D9\uA900-\uA909\uA9D0-\uA9D9\uAA50-\uAA59\uABF0-\uABF9\uFF10-\uFF19]+/g;
  
  global.define = __define;
  return module.exports;
});

System.register("npm:sentence-case@1.1.0/vendor/camel-case-regexp", [], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/sentence-case@1.1.0/vendor/camel-case-regexp.js";
  var __dirname = "jspm_packages/npm/sentence-case@1.1.0/vendor";
  "format cjs";
  module.exports = /([\u0061-\u007A\u00B5\u00DF-\u00F6\u00F8-\u00FF\u0101\u0103\u0105\u0107\u0109\u010B\u010D\u010F\u0111\u0113\u0115\u0117\u0119\u011B\u011D\u011F\u0121\u0123\u0125\u0127\u0129\u012B\u012D\u012F\u0131\u0133\u0135\u0137\u0138\u013A\u013C\u013E\u0140\u0142\u0144\u0146\u0148\u0149\u014B\u014D\u014F\u0151\u0153\u0155\u0157\u0159\u015B\u015D\u015F\u0161\u0163\u0165\u0167\u0169\u016B\u016D\u016F\u0171\u0173\u0175\u0177\u017A\u017C\u017E-\u0180\u0183\u0185\u0188\u018C\u018D\u0192\u0195\u0199-\u019B\u019E\u01A1\u01A3\u01A5\u01A8\u01AA\u01AB\u01AD\u01B0\u01B4\u01B6\u01B9\u01BA\u01BD-\u01BF\u01C6\u01C9\u01CC\u01CE\u01D0\u01D2\u01D4\u01D6\u01D8\u01DA\u01DC\u01DD\u01DF\u01E1\u01E3\u01E5\u01E7\u01E9\u01EB\u01ED\u01EF\u01F0\u01F3\u01F5\u01F9\u01FB\u01FD\u01FF\u0201\u0203\u0205\u0207\u0209\u020B\u020D\u020F\u0211\u0213\u0215\u0217\u0219\u021B\u021D\u021F\u0221\u0223\u0225\u0227\u0229\u022B\u022D\u022F\u0231\u0233-\u0239\u023C\u023F\u0240\u0242\u0247\u0249\u024B\u024D\u024F-\u0293\u0295-\u02AF\u0371\u0373\u0377\u037B-\u037D\u0390\u03AC-\u03CE\u03D0\u03D1\u03D5-\u03D7\u03D9\u03DB\u03DD\u03DF\u03E1\u03E3\u03E5\u03E7\u03E9\u03EB\u03ED\u03EF-\u03F3\u03F5\u03F8\u03FB\u03FC\u0430-\u045F\u0461\u0463\u0465\u0467\u0469\u046B\u046D\u046F\u0471\u0473\u0475\u0477\u0479\u047B\u047D\u047F\u0481\u048B\u048D\u048F\u0491\u0493\u0495\u0497\u0499\u049B\u049D\u049F\u04A1\u04A3\u04A5\u04A7\u04A9\u04AB\u04AD\u04AF\u04B1\u04B3\u04B5\u04B7\u04B9\u04BB\u04BD\u04BF\u04C2\u04C4\u04C6\u04C8\u04CA\u04CC\u04CE\u04CF\u04D1\u04D3\u04D5\u04D7\u04D9\u04DB\u04DD\u04DF\u04E1\u04E3\u04E5\u04E7\u04E9\u04EB\u04ED\u04EF\u04F1\u04F3\u04F5\u04F7\u04F9\u04FB\u04FD\u04FF\u0501\u0503\u0505\u0507\u0509\u050B\u050D\u050F\u0511\u0513\u0515\u0517\u0519\u051B\u051D\u051F\u0521\u0523\u0525\u0527\u0561-\u0587\u1D00-\u1D2B\u1D6B-\u1D77\u1D79-\u1D9A\u1E01\u1E03\u1E05\u1E07\u1E09\u1E0B\u1E0D\u1E0F\u1E11\u1E13\u1E15\u1E17\u1E19\u1E1B\u1E1D\u1E1F\u1E21\u1E23\u1E25\u1E27\u1E29\u1E2B\u1E2D\u1E2F\u1E31\u1E33\u1E35\u1E37\u1E39\u1E3B\u1E3D\u1E3F\u1E41\u1E43\u1E45\u1E47\u1E49\u1E4B\u1E4D\u1E4F\u1E51\u1E53\u1E55\u1E57\u1E59\u1E5B\u1E5D\u1E5F\u1E61\u1E63\u1E65\u1E67\u1E69\u1E6B\u1E6D\u1E6F\u1E71\u1E73\u1E75\u1E77\u1E79\u1E7B\u1E7D\u1E7F\u1E81\u1E83\u1E85\u1E87\u1E89\u1E8B\u1E8D\u1E8F\u1E91\u1E93\u1E95-\u1E9D\u1E9F\u1EA1\u1EA3\u1EA5\u1EA7\u1EA9\u1EAB\u1EAD\u1EAF\u1EB1\u1EB3\u1EB5\u1EB7\u1EB9\u1EBB\u1EBD\u1EBF\u1EC1\u1EC3\u1EC5\u1EC7\u1EC9\u1ECB\u1ECD\u1ECF\u1ED1\u1ED3\u1ED5\u1ED7\u1ED9\u1EDB\u1EDD\u1EDF\u1EE1\u1EE3\u1EE5\u1EE7\u1EE9\u1EEB\u1EED\u1EEF\u1EF1\u1EF3\u1EF5\u1EF7\u1EF9\u1EFB\u1EFD\u1EFF-\u1F07\u1F10-\u1F15\u1F20-\u1F27\u1F30-\u1F37\u1F40-\u1F45\u1F50-\u1F57\u1F60-\u1F67\u1F70-\u1F7D\u1F80-\u1F87\u1F90-\u1F97\u1FA0-\u1FA7\u1FB0-\u1FB4\u1FB6\u1FB7\u1FBE\u1FC2-\u1FC4\u1FC6\u1FC7\u1FD0-\u1FD3\u1FD6\u1FD7\u1FE0-\u1FE7\u1FF2-\u1FF4\u1FF6\u1FF7\u210A\u210E\u210F\u2113\u212F\u2134\u2139\u213C\u213D\u2146-\u2149\u214E\u2184\u2C30-\u2C5E\u2C61\u2C65\u2C66\u2C68\u2C6A\u2C6C\u2C71\u2C73\u2C74\u2C76-\u2C7B\u2C81\u2C83\u2C85\u2C87\u2C89\u2C8B\u2C8D\u2C8F\u2C91\u2C93\u2C95\u2C97\u2C99\u2C9B\u2C9D\u2C9F\u2CA1\u2CA3\u2CA5\u2CA7\u2CA9\u2CAB\u2CAD\u2CAF\u2CB1\u2CB3\u2CB5\u2CB7\u2CB9\u2CBB\u2CBD\u2CBF\u2CC1\u2CC3\u2CC5\u2CC7\u2CC9\u2CCB\u2CCD\u2CCF\u2CD1\u2CD3\u2CD5\u2CD7\u2CD9\u2CDB\u2CDD\u2CDF\u2CE1\u2CE3\u2CE4\u2CEC\u2CEE\u2CF3\u2D00-\u2D25\u2D27\u2D2D\uA641\uA643\uA645\uA647\uA649\uA64B\uA64D\uA64F\uA651\uA653\uA655\uA657\uA659\uA65B\uA65D\uA65F\uA661\uA663\uA665\uA667\uA669\uA66B\uA66D\uA681\uA683\uA685\uA687\uA689\uA68B\uA68D\uA68F\uA691\uA693\uA695\uA697\uA723\uA725\uA727\uA729\uA72B\uA72D\uA72F-\uA731\uA733\uA735\uA737\uA739\uA73B\uA73D\uA73F\uA741\uA743\uA745\uA747\uA749\uA74B\uA74D\uA74F\uA751\uA753\uA755\uA757\uA759\uA75B\uA75D\uA75F\uA761\uA763\uA765\uA767\uA769\uA76B\uA76D\uA76F\uA771-\uA778\uA77A\uA77C\uA77F\uA781\uA783\uA785\uA787\uA78C\uA78E\uA791\uA793\uA7A1\uA7A3\uA7A5\uA7A7\uA7A9\uA7FA\uFB00-\uFB06\uFB13-\uFB17\uFF41-\uFF5A])([\u0041-\u005A\u00C0-\u00D6\u00D8-\u00DE\u0100\u0102\u0104\u0106\u0108\u010A\u010C\u010E\u0110\u0112\u0114\u0116\u0118\u011A\u011C\u011E\u0120\u0122\u0124\u0126\u0128\u012A\u012C\u012E\u0130\u0132\u0134\u0136\u0139\u013B\u013D\u013F\u0141\u0143\u0145\u0147\u014A\u014C\u014E\u0150\u0152\u0154\u0156\u0158\u015A\u015C\u015E\u0160\u0162\u0164\u0166\u0168\u016A\u016C\u016E\u0170\u0172\u0174\u0176\u0178\u0179\u017B\u017D\u0181\u0182\u0184\u0186\u0187\u0189-\u018B\u018E-\u0191\u0193\u0194\u0196-\u0198\u019C\u019D\u019F\u01A0\u01A2\u01A4\u01A6\u01A7\u01A9\u01AC\u01AE\u01AF\u01B1-\u01B3\u01B5\u01B7\u01B8\u01BC\u01C4\u01C7\u01CA\u01CD\u01CF\u01D1\u01D3\u01D5\u01D7\u01D9\u01DB\u01DE\u01E0\u01E2\u01E4\u01E6\u01E8\u01EA\u01EC\u01EE\u01F1\u01F4\u01F6-\u01F8\u01FA\u01FC\u01FE\u0200\u0202\u0204\u0206\u0208\u020A\u020C\u020E\u0210\u0212\u0214\u0216\u0218\u021A\u021C\u021E\u0220\u0222\u0224\u0226\u0228\u022A\u022C\u022E\u0230\u0232\u023A\u023B\u023D\u023E\u0241\u0243-\u0246\u0248\u024A\u024C\u024E\u0370\u0372\u0376\u0386\u0388-\u038A\u038C\u038E\u038F\u0391-\u03A1\u03A3-\u03AB\u03CF\u03D2-\u03D4\u03D8\u03DA\u03DC\u03DE\u03E0\u03E2\u03E4\u03E6\u03E8\u03EA\u03EC\u03EE\u03F4\u03F7\u03F9\u03FA\u03FD-\u042F\u0460\u0462\u0464\u0466\u0468\u046A\u046C\u046E\u0470\u0472\u0474\u0476\u0478\u047A\u047C\u047E\u0480\u048A\u048C\u048E\u0490\u0492\u0494\u0496\u0498\u049A\u049C\u049E\u04A0\u04A2\u04A4\u04A6\u04A8\u04AA\u04AC\u04AE\u04B0\u04B2\u04B4\u04B6\u04B8\u04BA\u04BC\u04BE\u04C0\u04C1\u04C3\u04C5\u04C7\u04C9\u04CB\u04CD\u04D0\u04D2\u04D4\u04D6\u04D8\u04DA\u04DC\u04DE\u04E0\u04E2\u04E4\u04E6\u04E8\u04EA\u04EC\u04EE\u04F0\u04F2\u04F4\u04F6\u04F8\u04FA\u04FC\u04FE\u0500\u0502\u0504\u0506\u0508\u050A\u050C\u050E\u0510\u0512\u0514\u0516\u0518\u051A\u051C\u051E\u0520\u0522\u0524\u0526\u0531-\u0556\u10A0-\u10C5\u10C7\u10CD\u1E00\u1E02\u1E04\u1E06\u1E08\u1E0A\u1E0C\u1E0E\u1E10\u1E12\u1E14\u1E16\u1E18\u1E1A\u1E1C\u1E1E\u1E20\u1E22\u1E24\u1E26\u1E28\u1E2A\u1E2C\u1E2E\u1E30\u1E32\u1E34\u1E36\u1E38\u1E3A\u1E3C\u1E3E\u1E40\u1E42\u1E44\u1E46\u1E48\u1E4A\u1E4C\u1E4E\u1E50\u1E52\u1E54\u1E56\u1E58\u1E5A\u1E5C\u1E5E\u1E60\u1E62\u1E64\u1E66\u1E68\u1E6A\u1E6C\u1E6E\u1E70\u1E72\u1E74\u1E76\u1E78\u1E7A\u1E7C\u1E7E\u1E80\u1E82\u1E84\u1E86\u1E88\u1E8A\u1E8C\u1E8E\u1E90\u1E92\u1E94\u1E9E\u1EA0\u1EA2\u1EA4\u1EA6\u1EA8\u1EAA\u1EAC\u1EAE\u1EB0\u1EB2\u1EB4\u1EB6\u1EB8\u1EBA\u1EBC\u1EBE\u1EC0\u1EC2\u1EC4\u1EC6\u1EC8\u1ECA\u1ECC\u1ECE\u1ED0\u1ED2\u1ED4\u1ED6\u1ED8\u1EDA\u1EDC\u1EDE\u1EE0\u1EE2\u1EE4\u1EE6\u1EE8\u1EEA\u1EEC\u1EEE\u1EF0\u1EF2\u1EF4\u1EF6\u1EF8\u1EFA\u1EFC\u1EFE\u1F08-\u1F0F\u1F18-\u1F1D\u1F28-\u1F2F\u1F38-\u1F3F\u1F48-\u1F4D\u1F59\u1F5B\u1F5D\u1F5F\u1F68-\u1F6F\u1FB8-\u1FBB\u1FC8-\u1FCB\u1FD8-\u1FDB\u1FE8-\u1FEC\u1FF8-\u1FFB\u2102\u2107\u210B-\u210D\u2110-\u2112\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u2130-\u2133\u213E\u213F\u2145\u2183\u2C00-\u2C2E\u2C60\u2C62-\u2C64\u2C67\u2C69\u2C6B\u2C6D-\u2C70\u2C72\u2C75\u2C7E-\u2C80\u2C82\u2C84\u2C86\u2C88\u2C8A\u2C8C\u2C8E\u2C90\u2C92\u2C94\u2C96\u2C98\u2C9A\u2C9C\u2C9E\u2CA0\u2CA2\u2CA4\u2CA6\u2CA8\u2CAA\u2CAC\u2CAE\u2CB0\u2CB2\u2CB4\u2CB6\u2CB8\u2CBA\u2CBC\u2CBE\u2CC0\u2CC2\u2CC4\u2CC6\u2CC8\u2CCA\u2CCC\u2CCE\u2CD0\u2CD2\u2CD4\u2CD6\u2CD8\u2CDA\u2CDC\u2CDE\u2CE0\u2CE2\u2CEB\u2CED\u2CF2\uA640\uA642\uA644\uA646\uA648\uA64A\uA64C\uA64E\uA650\uA652\uA654\uA656\uA658\uA65A\uA65C\uA65E\uA660\uA662\uA664\uA666\uA668\uA66A\uA66C\uA680\uA682\uA684\uA686\uA688\uA68A\uA68C\uA68E\uA690\uA692\uA694\uA696\uA722\uA724\uA726\uA728\uA72A\uA72C\uA72E\uA732\uA734\uA736\uA738\uA73A\uA73C\uA73E\uA740\uA742\uA744\uA746\uA748\uA74A\uA74C\uA74E\uA750\uA752\uA754\uA756\uA758\uA75A\uA75C\uA75E\uA760\uA762\uA764\uA766\uA768\uA76A\uA76C\uA76E\uA779\uA77B\uA77D\uA77E\uA780\uA782\uA784\uA786\uA78B\uA78D\uA790\uA792\uA7A0\uA7A2\uA7A4\uA7A6\uA7A8\uA7AA\uFF21-\uFF3A\u0030-\u0039\u00B2\u00B3\u00B9\u00BC-\u00BE\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u09F4-\u09F9\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0B72-\u0B77\u0BE6-\u0BF2\u0C66-\u0C6F\u0C78-\u0C7E\u0CE6-\u0CEF\u0D66-\u0D75\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F33\u1040-\u1049\u1090-\u1099\u1369-\u137C\u16EE-\u16F0\u17E0-\u17E9\u17F0-\u17F9\u1810-\u1819\u1946-\u194F\u19D0-\u19DA\u1A80-\u1A89\u1A90-\u1A99\u1B50-\u1B59\u1BB0-\u1BB9\u1C40-\u1C49\u1C50-\u1C59\u2070\u2074-\u2079\u2080-\u2089\u2150-\u2182\u2185-\u2189\u2460-\u249B\u24EA-\u24FF\u2776-\u2793\u2CFD\u3007\u3021-\u3029\u3038-\u303A\u3192-\u3195\u3220-\u3229\u3248-\u324F\u3251-\u325F\u3280-\u3289\u32B1-\u32BF\uA620-\uA629\uA6E6-\uA6EF\uA830-\uA835\uA8D0-\uA8D9\uA900-\uA909\uA9D0-\uA9D9\uAA50-\uAA59\uABF0-\uABF9\uFF10-\uFF19])/g;
  
  global.define = __define;
  return module.exports;
});

System.register("npm:sentence-case@1.1.0/vendor/trailing-digit-regexp", [], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/sentence-case@1.1.0/vendor/trailing-digit-regexp.js";
  var __dirname = "jspm_packages/npm/sentence-case@1.1.0/vendor";
  "format cjs";
  module.exports = /([\u0030-\u0039\u00B2\u00B3\u00B9\u00BC-\u00BE\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u09F4-\u09F9\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0B72-\u0B77\u0BE6-\u0BF2\u0C66-\u0C6F\u0C78-\u0C7E\u0CE6-\u0CEF\u0D66-\u0D75\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F33\u1040-\u1049\u1090-\u1099\u1369-\u137C\u16EE-\u16F0\u17E0-\u17E9\u17F0-\u17F9\u1810-\u1819\u1946-\u194F\u19D0-\u19DA\u1A80-\u1A89\u1A90-\u1A99\u1B50-\u1B59\u1BB0-\u1BB9\u1C40-\u1C49\u1C50-\u1C59\u2070\u2074-\u2079\u2080-\u2089\u2150-\u2182\u2185-\u2189\u2460-\u249B\u24EA-\u24FF\u2776-\u2793\u2CFD\u3007\u3021-\u3029\u3038-\u303A\u3192-\u3195\u3220-\u3229\u3248-\u324F\u3251-\u325F\u3280-\u3289\u32B1-\u32BF\uA620-\uA629\uA6E6-\uA6EF\uA830-\uA835\uA8D0-\uA8D9\uA900-\uA909\uA9D0-\uA9D9\uAA50-\uAA59\uABF0-\uABF9\uFF10-\uFF19])([^\u0030-\u0039\u00B2\u00B3\u00B9\u00BC-\u00BE\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u09F4-\u09F9\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0B72-\u0B77\u0BE6-\u0BF2\u0C66-\u0C6F\u0C78-\u0C7E\u0CE6-\u0CEF\u0D66-\u0D75\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F33\u1040-\u1049\u1090-\u1099\u1369-\u137C\u16EE-\u16F0\u17E0-\u17E9\u17F0-\u17F9\u1810-\u1819\u1946-\u194F\u19D0-\u19DA\u1A80-\u1A89\u1A90-\u1A99\u1B50-\u1B59\u1BB0-\u1BB9\u1C40-\u1C49\u1C50-\u1C59\u2070\u2074-\u2079\u2080-\u2089\u2150-\u2182\u2185-\u2189\u2460-\u249B\u24EA-\u24FF\u2776-\u2793\u2CFD\u3007\u3021-\u3029\u3038-\u303A\u3192-\u3195\u3220-\u3229\u3248-\u324F\u3251-\u325F\u3280-\u3289\u32B1-\u32BF\uA620-\uA629\uA6E6-\uA6EF\uA830-\uA835\uA8D0-\uA8D9\uA900-\uA909\uA9D0-\uA9D9\uAA50-\uAA59\uABF0-\uABF9\uFF10-\uFF19])/g;
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/dataFiles/dataFileActions", ["npm:reflux@0.1.12"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/dataFiles/dataFileActions.js";
  var __dirname = "build/src/dataFiles";
  var Reflux = require("npm:reflux@0.1.12");
  module.exports = Reflux.createActions(['add']);
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/compare/compareStore", ["npm:reflux@0.1.12","build/src/compare/compareActions"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/compare/compareStore.js";
  var __dirname = "build/src/compare";
  var Reflux = require("npm:reflux@0.1.12");
  var compareActions = require("build/src/compare/compareActions");
  module.exports = Reflux.createStore({
    listenables: compareActions,
    init: function() {
      this.comparison = {};
    },
    onSetResults: function(comparison) {
      this.comparison = comparison;
      this.trigger(this.comparison);
    }
  });
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/components/DataFileList", ["github:reactjs/react-bower@0.11.2","npm:reflux@0.1.12","build/src/dataFiles/dataFileStore"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/components/DataFileList.js";
  var __dirname = "build/src/components";
  var React = require("github:reactjs/react-bower@0.11.2");
  var Reflux = require("npm:reflux@0.1.12");
  var dataFileStore = require("build/src/dataFiles/dataFileStore");
  var DataFileList = module.exports = React.createClass({
    displayName: 'DataFileList',
    mixins: [Reflux.connect(dataFileStore, 'dataFiles')],
    getInitialState: function() {
      return {dataFiles: {}};
    },
    buildDataFileList: function(dataFiles) {
      var dataFileList = [];
      Object.keys(dataFiles).forEach(function(key) {
        dataFileList.push(dataFiles[key]);
      });
      return dataFileList;
    },
    onDataFileStoreUpdate: function(dataFiles) {
      this.setState({dataFiles: dataFiles});
    },
    render: function() {
      var dataFileList = this.buildDataFileList(this.state.dataFiles);
      var dataFileListNodes = [];
      for (var i = 0; i < dataFileList.length; i++) {
        dataFileListNodes.push(React.DOM.li({key: dataFileList[i].id}, dataFileList[i].filename));
      }
      return (React.DOM.ul({className: "data-file-list"}, dataFileListNodes));
    }
  });
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/components/DataFileUploadStatus", ["github:reactjs/react-bower@0.11.2"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/components/DataFileUploadStatus.js";
  var __dirname = "build/src/components";
  var React = require("github:reactjs/react-bower@0.11.2");
  var DataFileUploadStatus = module.exports = React.createClass({
    displayName: 'DataFileUploadStatus',
    render: function() {
      return (React.DOM.div(null));
    }
  });
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/dataFiles/dataFileService", ["npm:es6-promise@1.0.0","build/src/services/transport"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/dataFiles/dataFileService.js";
  var __dirname = "build/src/dataFiles";
  var ES6Promise = require("npm:es6-promise@1.0.0").Promise;
  var transport = require("build/src/services/transport");
  var DATA_FILES_URL = '/files/data_files/';
  var blobUploadUrl = dgGlobal.blobUploadURL;
  var dataFileService = module.exports = {};
  dataFileService.upload = function(fileList, progressCallback) {
    return new ES6Promise(function(resolve, reject) {
      var formData = new FormData();
      for (var i = 0; i < fileList.length; i++) {
        formData.append('file[]', fileList[i]);
      }
      transport.send(blobUploadUrl, 'post', formData, progressCallback).then(function(response) {
        if (response && response.nextBlobUploadUrl) {
          blobUploadUrl = response.nextBlobUploadUrl;
        }
        if (response && response.data && response.data.dataFileIds) {
          dataFileService.get(response.data.dataFileIds).then(resolve, reject);
        } else {
          reject(new Error('Invalid response: ' + response));
        }
      }, function(error) {
        console.error(error);
        reject(error);
      });
    });
  };
  dataFileService.get = function(dataFileIds) {
    return new ES6Promise(function(resolve, reject) {
      var url = DATA_FILES_URL + '?';
      var queryStr = dataFileIds.map(function(id) {
        return 'id=' + id;
      }).join('&');
      url += queryStr;
      transport.send(url, 'get').then(function(response) {
        if (response && response.data && response.data.dataFiles) {
          resolve(response.data.dataFiles);
        } else {
          reject(new Error('Invalid response: ' + response));
        }
      }, function(error) {
        console.error(error);
      });
    });
  };
  dataFileService.getSingle = function(dataFileId) {
    return new ES6Promise(function(resolve, reject) {
      dataFileService.get([dataFileId]).then(function(dataFiles) {
        resolve(dataFiles[0]);
      }, reject);
    });
  };
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/components/Main", ["github:reactjs/react-bower@0.11.2","npm:react-router@0.7.0"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/components/Main.js";
  var __dirname = "build/src/components";
  var React = require("github:reactjs/react-bower@0.11.2");
  var Link = require("npm:react-router@0.7.0").Link;
  var Main = module.exports = React.createClass({
    displayName: 'Main',
    render: function() {
      return (React.DOM.div({className: "main"}, React.DOM.p({className: "lead"}, "What do you need me to do?"), React.DOM.ul({className: "menu"}, React.DOM.li(null, Link({to: "compare"}, React.DOM.p(null, "Compare CSV Files"))))));
    }
  });
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/components/NotFound", ["github:reactjs/react-bower@0.11.2"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/components/NotFound.js";
  var __dirname = "build/src/components";
  var React = require("github:reactjs/react-bower@0.11.2");
  var NotFound = module.exports = React.createClass({
    displayName: 'NotFound',
    render: function() {
      return (React.DOM.h1(null, "Not Found"));
    }
  });
  
  global.define = __define;
  return module.exports;
});

System.register("github:reactjs/react-bower@0.11.2", ["github:reactjs/react-bower@0.11.2/react"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/github/reactjs/react-bower@0.11.2.js";
  var __dirname = "jspm_packages/github/reactjs";
  module.exports = require("github:reactjs/react-bower@0.11.2/react");
  
  global.define = __define;
  return module.exports;
});

System.register("npm:react-router@0.7.0/dist/react-router", ["github:jspm/nodelibs@0.0.3/process"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/react-router@0.7.0/dist/react-router.js";
  var __dirname = "jspm_packages/npm/react-router@0.7.0/dist";
  "format cjs";
  !function(e) {
    !function(e) {
      if ("object" == typeof exports && "undefined" != typeof module)
        module.exports = e();
      else if ("function" == typeof define && define.amd)
        define([], e);
      else {
        var t;
        "undefined" != typeof window ? t = window : "undefined" != typeof global ? t = global : "undefined" != typeof self && (t = self), t.ReactRouter = e();
      }
    }(function() {
      var t;
      return function n(e, t, r) {
        function i(o, a) {
          if (!t[o]) {
            if (!e[o]) {
              var c = "function" == typeof require && require;
              if (!a && c)
                return c(o, !0);
              if (s)
                return s(o, !0);
              throw new Error("Cannot find module '" + o + "'");
            }
            var u = t[o] = {exports: {}};
            e[o][0].call(u.exports, function(t) {
              var n = e[o][1][t];
              return i(n ? n : t);
            }, u, u.exports, n, e, t, r);
          }
          return t[o].exports;
        }
        for (var s = "function" == typeof require && require,
            o = 0; o < r.length; o++)
          i(r[o]);
        return i;
      }({
        1: [function(e, t) {
          var n = e("../dispatchers/LocationDispatcher"),
              r = e("../utils/makePath"),
              i = {
                PUSH: "push",
                REPLACE: "replace",
                POP: "pop",
                UPDATE_SCROLL: "update-scroll",
                transitionTo: function(e, t, s) {
                  n.handleViewAction({
                    type: i.PUSH,
                    path: r(e, t, s)
                  });
                },
                replaceWith: function(e, t, s) {
                  n.handleViewAction({
                    type: i.REPLACE,
                    path: r(e, t, s)
                  });
                },
                goBack: function() {
                  n.handleViewAction({type: i.POP});
                },
                updateScroll: function() {
                  n.handleViewAction({type: i.UPDATE_SCROLL});
                }
              };
          t.exports = i;
        }, {
          "../dispatchers/LocationDispatcher": 8,
          "../utils/makePath": 26
        }],
        2: [function(e, t) {
          function n(e) {
            return i(r(e, {
              path: null,
              isDefault: !0
            }));
          }
          var r = e("react/lib/merge"),
              i = e("./Route");
          t.exports = n;
        }, {
          "./Route": 6,
          "react/lib/merge": 44
        }],
        3: [function(e, t) {
          function n(e) {
            return 0 === e.button;
          }
          function r(e) {
            return !!(e.metaKey || e.altKey || e.ctrlKey || e.shiftKey);
          }
          var i = "undefined" != typeof window ? window.React : "undefined" != typeof global ? global.React : null,
              s = e("../mixins/ActiveState"),
              o = e("../actions/LocationActions").transitionTo,
              a = e("../utils/withoutProperties"),
              c = e("../utils/hasOwnProperty"),
              u = e("../utils/makeHref"),
              l = e("react/lib/warning"),
              h = {
                to: !0,
                key: !0,
                className: !0,
                activeClassName: !0,
                query: !0,
                onClick: !0,
                children: !0
              },
              p = i.createClass({
                displayName: "Link",
                mixins: [s],
                statics: {
                  getUnreservedProps: function(e) {
                    var e = a(e, h);
                    return l(0 === Object.keys(e).length, "Passing props for params on <Link>s is deprecated, please use the `params` property."), e;
                  },
                  getParams: function(e) {
                    return e.params || p.getUnreservedProps(e);
                  }
                },
                propTypes: {
                  to: i.PropTypes.string.isRequired,
                  activeClassName: i.PropTypes.string.isRequired,
                  params: i.PropTypes.object,
                  query: i.PropTypes.object,
                  onClick: i.PropTypes.func
                },
                getDefaultProps: function() {
                  return {activeClassName: "active"};
                },
                getInitialState: function() {
                  return {isActive: !1};
                },
                getHref: function() {
                  return u(this.props.to, p.getParams(this.props), this.props.query);
                },
                getClassName: function() {
                  var e = this.props.className || "";
                  return this.state.isActive ? e + " " + this.props.activeClassName : e;
                },
                componentWillReceiveProps: function(e) {
                  var t = p.getParams(e);
                  this.setState({isActive: p.isActive(e.to, t, e.query)});
                },
                updateActiveState: function() {
                  this.setState({isActive: p.isActive(this.props.to, p.getParams(this.props), this.props.query)});
                },
                handleClick: function(e) {
                  var t,
                      i = !0;
                  this.props.onClick && (t = this.props.onClick(e)), !r(e) && n(e) && ((t === !1 || e.defaultPrevented === !0) && (i = !1), e.preventDefault(), i && o(this.props.to, p.getParams(this.props), this.props.query));
                },
                render: function() {
                  var e = {
                    href: this.getHref(),
                    className: this.getClassName(),
                    onClick: this.handleClick
                  };
                  for (var t in this.props)
                    c(this.props, t) && c(e, t) === !1 && (e[t] = this.props[t]);
                  return i.DOM.a(e, this.props.children);
                }
              });
          t.exports = p;
        }, {
          "../actions/LocationActions": 1,
          "../mixins/ActiveState": 15,
          "../utils/hasOwnProperty": 24,
          "../utils/makeHref": 25,
          "../utils/withoutProperties": 29,
          "react/lib/warning": 48
        }],
        4: [function(e, t) {
          function n(e) {
            return i(r(e, {
              path: null,
              catchAll: !0
            }));
          }
          var r = e("react/lib/merge"),
              i = e("./Route");
          t.exports = n;
        }, {
          "./Route": 6,
          "react/lib/merge": 44
        }],
        5: [function(e, t) {
          function n(e) {
            return i.createClass({
              statics: {willTransitionTo: function(t, n, r) {
                  t.redirect(e, n, r);
                }},
              render: function() {
                return null;
              }
            });
          }
          function r(e) {
            return s({
              name: e.name,
              path: e.from || e.path || "*",
              handler: n(e.to)
            });
          }
          var i = "undefined" != typeof window ? window.React : "undefined" != typeof global ? global.React : null,
              s = e("./Route");
          t.exports = r;
        }, {"./Route": 6}],
        6: [function(e, t) {
          var n = "undefined" != typeof window ? window.React : "undefined" != typeof global ? global.React : null,
              r = e("../utils/withoutProperties"),
              i = {
                handler: !0,
                path: !0,
                defaultRoute: !0,
                paramNames: !0,
                children: !0
              },
              s = n.createClass({
                displayName: "Route",
                statics: {getUnreservedProps: function(e) {
                    return r(e, i);
                  }},
                propTypes: {
                  preserveScrollPosition: n.PropTypes.bool.isRequired,
                  handler: n.PropTypes.any.isRequired,
                  path: n.PropTypes.string,
                  name: n.PropTypes.string
                },
                getDefaultProps: function() {
                  return {preserveScrollPosition: !1};
                },
                render: function() {
                  throw new Error("The <Route> component should not be rendered directly. You may be missing a <Routes> wrapper around your list of routes.");
                }
              });
          t.exports = s;
        }, {"../utils/withoutProperties": 29}],
        7: [function(e, t) {
          function n(e) {
            var t = e.abortReason;
            t instanceof x ? _.replaceWith(t.to, t.params, t.query) : _.goBack();
          }
          function r(e) {
            j.updateState(e);
          }
          function i(e) {
            throw e;
          }
          function s(e, t) {
            e.props.preserveScrollPosition || t.props.preserveScrollPosition || _.updateScroll();
          }
          function o(e, t, n, r) {
            for (var i,
                s,
                c = null,
                l = 0,
                h = t.length; h > l; ++l) {
              if (i = t[l], c = o(e, i.props.children, i.props.defaultRoute, i.props.notFoundRoute), null != c) {
                var p = u(c).params;
                return s = i.props.paramNames.reduce(function(e, t) {
                  return e[t] = p[t], e;
                }, {}), c.unshift(a(i, s)), c;
              }
              if (s = L.extractParams(i.props.path, e))
                return [a(i, s)];
            }
            return n && (s = L.extractParams(n.props.path, e)) ? [a(n, s)] : r && (s = L.extractParams(r.props.path, e)) ? [a(r, s)] : c;
          }
          function a(e, t) {
            return {
              route: e,
              params: t
            };
          }
          function c(e, t) {
            return e.some(function(e) {
              if (e.route !== t.route)
                return !1;
              for (var n in e.params)
                if (e.params[n] !== t.params[n])
                  return !1;
              return !0;
            });
          }
          function u(e) {
            return e[e.length - 1];
          }
          function l(e, t) {
            for (var n,
                r = 0; n = t[S]; )
              e[r++].component = n, t = n.refs;
          }
          function h(e, t) {
            if (e.state.path === t.path)
              return b.resolve();
            var n = e.state.matches,
                r = e.match(t.path);
            g(r, 'No route matches path "' + t.path + '". Make sure you have <Route path="' + t.path + '"> somewhere in your routes'), r || (r = []);
            var i,
                s;
            n ? (l(n, e.refs), i = n.filter(function(e) {
              return !c(r, e);
            }), s = r.filter(function(e) {
              return !c(n, e);
            })) : (i = [], s = r);
            var o = L.extractQuery(t.path) || {};
            return p(i, t).then(function() {
              return t.isAborted ? void 0 : f(s, t, o).then(function() {
                if (!t.isAborted) {
                  var e = u(r),
                      n = e && e.params || {};
                  return {
                    path: t.path,
                    matches: r,
                    activeParams: n,
                    activeQuery: o,
                    activeRoutes: r.map(function(e) {
                      return e.route;
                    })
                  };
                }
              });
            });
          }
          function p(e, t) {
            var n = b.resolve();
            return m(e).forEach(function(e) {
              n = n.then(function() {
                var n = e.route.props.handler;
                return !t.isAborted && n.willTransitionFrom ? n.willTransitionFrom(t, e.component) : void 0;
              });
            }), n;
          }
          function f(e, t, n) {
            var r = b.resolve();
            return e.forEach(function(e) {
              r = r.then(function() {
                var r = e.route.props.handler;
                return !t.isAborted && r.willTransitionTo ? r.willTransitionTo(t, e.params, n) : void 0;
              });
            }), r;
          }
          function d(e, t) {
            var n,
                r = {
                  ref: null,
                  key: null,
                  params: null,
                  query: null,
                  activeRouteHandler: v
                };
            return m(e).forEach(function(e) {
              var i = e.route;
              r = E.getUnreservedProps(i.props), r.ref = S, r.params = e.params, r.query = t, i.props.addHandlerKey && (r.key = L.injectParams(i.props.path, e.params)), r.activeRouteHandler = n ? n : v, n = function(e, t) {
                if (arguments.length > 2 && "undefined" != typeof arguments[2])
                  throw new Error("Passing children to a route handler is not supported");
                return i.props.handler(w(e, t));
              }.bind(this, r);
            }), r;
          }
          function v() {
            return null;
          }
          function m(e) {
            return e.slice(0).reverse();
          }
          var y = "undefined" != typeof window ? window.React : "undefined" != typeof global ? global.React : null,
              g = e("react/lib/warning"),
              w = e("react/lib/copyProperties"),
              b = e("when/lib/Promise"),
              _ = e("../actions/LocationActions"),
              E = e("../components/Route"),
              L = e("../utils/Path"),
              x = e("../utils/Redirect"),
              k = e("../utils/Transition"),
              A = e("../locations/DefaultLocation"),
              P = e("../locations/HashLocation"),
              D = e("../locations/HistoryLocation"),
              q = e("../locations/RefreshLocation"),
              j = e("../stores/ActiveStore"),
              R = e("../stores/PathStore"),
              C = e("../stores/RouteStore"),
              S = "__activeRoute__",
              O = {
                hash: P,
                history: D,
                refresh: q
              },
              $ = y.createClass({
                displayName: "Routes",
                propTypes: {
                  onAbortedTransition: y.PropTypes.func.isRequired,
                  onActiveStateChange: y.PropTypes.func.isRequired,
                  onTransitionError: y.PropTypes.func.isRequired,
                  preserveScrollPosition: y.PropTypes.bool,
                  location: function(e, t, n) {
                    var r = e[t];
                    return "string" != typeof r || r in O ? void 0 : new Error('Unknown location "' + r + '", see ' + n);
                  }
                },
                getDefaultProps: function() {
                  return {
                    onAbortedTransition: n,
                    onActiveStateChange: r,
                    onTransitionError: i,
                    preserveScrollPosition: !1,
                    location: A
                  };
                },
                getInitialState: function() {
                  return {routes: C.registerChildren(this.props.children, this)};
                },
                getLocation: function() {
                  var e = this.props.location;
                  return "string" == typeof e ? O[e] : e;
                },
                componentWillMount: function() {
                  R.setup(this.getLocation()), R.addChangeListener(this.handlePathChange);
                },
                componentDidMount: function() {
                  this.handlePathChange();
                },
                componentWillUnmount: function() {
                  R.removeChangeListener(this.handlePathChange);
                },
                handlePathChange: function() {
                  this.dispatch(R.getCurrentPath());
                },
                match: function(e) {
                  return o(L.withoutQuery(e), this.state.routes, this.props.defaultRoute, this.props.notFoundRoute);
                },
                dispatch: function(e, t) {
                  var n = new k(e),
                      r = this,
                      i = h(r, n).then(function(e) {
                        if (n.isAborted)
                          r.props.onAbortedTransition(n);
                        else if (e) {
                          r.setState(e), r.props.onActiveStateChange(e);
                          var t = u(e.matches);
                          t && s(r, t.route);
                        }
                        return n;
                      });
                  return t || (i = i.then(void 0, function(e) {
                    setTimeout(function() {
                      r.props.onTransitionError(e);
                    });
                  })), i;
                },
                render: function() {
                  if (!this.state.path)
                    return null;
                  var e = this.state.matches;
                  return e.length ? e[0].route.props.handler(d(e, this.state.activeQuery)) : null;
                }
              });
          t.exports = $;
        }, {
          "../actions/LocationActions": 1,
          "../components/Route": 6,
          "../locations/DefaultLocation": 10,
          "../locations/HashLocation": 11,
          "../locations/HistoryLocation": 12,
          "../locations/RefreshLocation": 14,
          "../stores/ActiveStore": 17,
          "../stores/PathStore": 18,
          "../stores/RouteStore": 19,
          "../utils/Path": 20,
          "../utils/Redirect": 21,
          "../utils/Transition": 22,
          "react/lib/copyProperties": 40,
          "react/lib/warning": 48,
          "when/lib/Promise": 49
        }],
        8: [function(e, t) {
          var n = e("react/lib/copyProperties"),
              r = e("flux").Dispatcher,
              i = n(new r, {handleViewAction: function(e) {
                  this.dispatch({
                    source: "VIEW_ACTION",
                    action: e
                  });
                }});
          t.exports = i;
        }, {
          flux: 31,
          "react/lib/copyProperties": 40
        }],
        9: [function(e, t, n) {
          n.goBack = e("./actions/LocationActions").goBack, n.replaceWith = e("./actions/LocationActions").replaceWith, n.transitionTo = e("./actions/LocationActions").transitionTo, n.DefaultRoute = e("./components/DefaultRoute"), n.Link = e("./components/Link"), n.NotFoundRoute = e("./components/NotFoundRoute"), n.Redirect = e("./components/Redirect"), n.Route = e("./components/Route"), n.Routes = e("./components/Routes"), n.ActiveState = e("./mixins/ActiveState"), n.AsyncState = e("./mixins/AsyncState"), n.makeHref = e("./utils/makeHref");
        }, {
          "./actions/LocationActions": 1,
          "./components/DefaultRoute": 2,
          "./components/Link": 3,
          "./components/NotFoundRoute": 4,
          "./components/Redirect": 5,
          "./components/Route": 6,
          "./components/Routes": 7,
          "./mixins/ActiveState": 15,
          "./mixins/AsyncState": 16,
          "./utils/makeHref": 25
        }],
        10: [function(e, t) {
          t.exports = e("./HashLocation");
        }, {
          "./HashLocation": 11,
          "./MemoryLocation": 13
        }],
        11: [function(e, t) {
          function n() {
            return window.location.hash.substr(1);
          }
          function r() {
            var e = n();
            return "/" === e.charAt(0) ? !0 : (u.replace("/" + e), !1);
          }
          function i() {
            r() && s();
          }
          var s,
              o = e("react/lib/invariant"),
              a = e("react/lib/ExecutionEnvironment"),
              c = e("../utils/getWindowPath"),
              u = {
                setup: function(e) {
                  o(a.canUseDOM, "You cannot use HashLocation in an environment with no DOM"), s = e, r(), window.addEventListener ? window.addEventListener("hashchange", i, !1) : window.attachEvent("onhashchange", i);
                },
                teardown: function() {
                  window.removeEventListener ? window.removeEventListener("hashchange", i, !1) : window.detachEvent("onhashchange", i);
                },
                push: function(e) {
                  window.location.hash = e;
                },
                replace: function(e) {
                  window.location.replace(c() + "#" + e);
                },
                pop: function() {
                  window.history.back();
                },
                getCurrentPath: n,
                toString: function() {
                  return "<HashLocation>";
                }
              };
          t.exports = u;
        }, {
          "../utils/getWindowPath": 23,
          "react/lib/ExecutionEnvironment": 39,
          "react/lib/invariant": 42
        }],
        12: [function(e, t) {
          var n,
              r = e("react/lib/invariant"),
              i = e("react/lib/ExecutionEnvironment"),
              s = e("../utils/getWindowPath"),
              o = {
                setup: function(e) {
                  r(i.canUseDOM, "You cannot use HistoryLocation in an environment with no DOM"), n = e, window.addEventListener ? window.addEventListener("popstate", n, !1) : window.attachEvent("popstate", n);
                },
                teardown: function() {
                  window.removeEventListener ? window.removeEventListener("popstate", n, !1) : window.detachEvent("popstate", n);
                },
                push: function(e) {
                  window.history.pushState({path: e}, "", e), n();
                },
                replace: function(e) {
                  window.history.replaceState({path: e}, "", e), n();
                },
                pop: function() {
                  window.history.back();
                },
                getCurrentPath: s,
                toString: function() {
                  return "<HistoryLocation>";
                }
              };
          t.exports = o;
        }, {
          "../utils/getWindowPath": 23,
          "react/lib/ExecutionEnvironment": 39,
          "react/lib/invariant": 42
        }],
        13: [function(e, t) {
          var n,
              r = e("react/lib/warning"),
              i = null,
              s = null,
              o = {
                setup: function(e) {
                  n = e;
                },
                push: function(e) {
                  i = s, s = e, n();
                },
                replace: function(e) {
                  s = e, n();
                },
                pop: function() {
                  r(null != i, "You cannot use MemoryLocation to go back more than once"), s = i, i = null, n();
                },
                getCurrentPath: function() {
                  return s || "/";
                },
                toString: function() {
                  return "<MemoryLocation>";
                }
              };
          t.exports = o;
        }, {"react/lib/warning": 48}],
        14: [function(e, t) {
          var n = e("react/lib/invariant"),
              r = e("react/lib/ExecutionEnvironment"),
              i = e("../utils/getWindowPath"),
              s = {
                setup: function() {
                  n(r.canUseDOM, "You cannot use RefreshLocation in an environment with no DOM");
                },
                push: function(e) {
                  window.location = e;
                },
                replace: function(e) {
                  window.location.replace(e);
                },
                pop: function() {
                  window.history.back();
                },
                getCurrentPath: i,
                toString: function() {
                  return "<RefreshLocation>";
                }
              };
          t.exports = s;
        }, {
          "../utils/getWindowPath": 23,
          "react/lib/ExecutionEnvironment": 39,
          "react/lib/invariant": 42
        }],
        15: [function(e, t) {
          var n = e("../stores/ActiveStore"),
              r = {
                statics: {isActive: n.isActive},
                componentWillMount: function() {
                  n.addChangeListener(this.handleActiveStateChange);
                },
                componentDidMount: function() {
                  this.updateActiveState && this.updateActiveState();
                },
                componentWillUnmount: function() {
                  n.removeChangeListener(this.handleActiveStateChange);
                },
                handleActiveStateChange: function() {
                  this.isMounted() && "function" == typeof this.updateActiveState && this.updateActiveState();
                }
              };
          t.exports = r;
        }, {"../stores/ActiveStore": 17}],
        16: [function(e, t) {
          var n = "undefined" != typeof window ? window.React : "undefined" != typeof global ? global.React : null,
              r = e("../utils/resolveAsyncState"),
              i = {
                propTypes: {initialAsyncState: n.PropTypes.object},
                getInitialState: function() {
                  return this.props.initialAsyncState || null;
                },
                updateAsyncState: function(e) {
                  this.isMounted() && this.setState(e);
                },
                componentDidMount: function() {
                  this.props.initialAsyncState || "function" != typeof this.constructor.getInitialAsyncState || r(this.constructor.getInitialAsyncState(this.props.params, this.props.query, this.updateAsyncState), this.updateAsyncState);
                }
              };
          t.exports = i;
        }, {"../utils/resolveAsyncState": 27}],
        17: [function(e, t) {
          function n() {
            c.emit(a);
          }
          function r(e) {
            return u.some(function(t) {
              return t.props.name === e;
            });
          }
          function i(e) {
            for (var t in e)
              if (l[t] !== String(e[t]))
                return !1;
            return !0;
          }
          function s(e) {
            for (var t in e)
              if (h[t] !== String(e[t]))
                return !1;
            return !0;
          }
          var o = e("events").EventEmitter,
              a = "change",
              c = new o;
          c.setMaxListeners(0);
          var u = [],
              l = {},
              h = {},
              p = {
                addChangeListener: function(e) {
                  c.on(a, e);
                },
                removeChangeListener: function(e) {
                  c.removeListener(a, e);
                },
                updateState: function(e) {
                  e = e || {}, u = e.activeRoutes || [], l = e.activeParams || {}, h = e.activeQuery || {}, n();
                },
                isActive: function(e, t, n) {
                  var o = r(e) && i(t);
                  return n ? o && s(n) : o;
                }
              };
          t.exports = p;
        }, {events: 30}],
        18: [function(e, t) {
          function n() {
            d.emit(f);
          }
          function r(e) {
            v[e] = {
              x: window.scrollX,
              y: window.scrollY
            };
          }
          function i(e) {
            var t = m.getScrollPosition(e);
            window.scrollTo(t.x, t.y);
          }
          var s,
              o = e("react/lib/warning"),
              a = e("events").EventEmitter,
              c = e("../actions/LocationActions"),
              u = e("../dispatchers/LocationDispatcher"),
              l = e("../utils/supportsHistory"),
              h = e("../locations/HistoryLocation"),
              p = e("../locations/RefreshLocation"),
              f = "change",
              d = new a,
              v = {},
              m = {
                addChangeListener: function(e) {
                  d.on(f, e);
                },
                removeChangeListener: function(e) {
                  d.removeListener(f, e), 0 === a.listenerCount(d, f) && m.teardown();
                },
                setup: function(e) {
                  e !== h || l() || (e = p), null == s ? (s = e, s && "function" == typeof s.setup && s.setup(n)) : o(s === e, "Cannot use location %s, already using %s", e, s);
                },
                teardown: function() {
                  d.removeAllListeners(f), s && "function" == typeof s.teardown && s.teardown(), s = null;
                },
                getLocation: function() {
                  return s;
                },
                getCurrentPath: function() {
                  return s.getCurrentPath();
                },
                getScrollPosition: function(e) {
                  return v[e] || {
                    x: 0,
                    y: 0
                  };
                },
                dispatchToken: u.register(function(e) {
                  var t = e.action,
                      n = s.getCurrentPath();
                  switch (t.type) {
                    case c.PUSH:
                      n !== t.path && (r(n), s.push(t.path));
                      break;
                    case c.REPLACE:
                      n !== t.path && (r(n), s.replace(t.path));
                      break;
                    case c.POP:
                      r(n), s.pop();
                      break;
                    case c.UPDATE_SCROLL:
                      i(n);
                  }
                })
              };
          t.exports = m;
        }, {
          "../actions/LocationActions": 1,
          "../dispatchers/LocationDispatcher": 8,
          "../locations/HistoryLocation": 12,
          "../locations/RefreshLocation": 14,
          "../utils/supportsHistory": 28,
          events: 30,
          "react/lib/warning": 48
        }],
        19: [function(e, t) {
          var n = "undefined" != typeof window ? window.React : "undefined" != typeof global ? global.React : null,
              r = e("react/lib/invariant"),
              i = (e("react/lib/warning"), e("../utils/Path")),
              s = {},
              o = {
                unregisterAllRoutes: function() {
                  s = {};
                },
                unregisterRoute: function(e) {
                  var t = e.props;
                  t.name && delete s[t.name], n.Children.forEach(t.children, o.unregisterRoute);
                },
                registerRoute: function(e, t) {
                  var a = e.props;
                  r(n.isValidClass(a.handler), 'The handler for the "%s" route must be a valid React class', a.name || a.path);
                  var c = t && t.props.path || "/";
                  if (!a.path && !a.name || a.isDefault || a.catchAll)
                    a.path = c, a.catchAll && (a.path += "*");
                  else {
                    var u = a.path || a.name;
                    i.isAbsolute(u) || (u = i.join(c, u)), a.path = i.normalize(u);
                  }
                  if (a.paramNames = i.extractParamNames(a.path), t && Array.isArray(t.props.paramNames) && t.props.paramNames.forEach(function(e) {
                    r(-1 !== a.paramNames.indexOf(e), 'The nested route path "%s" is missing the "%s" parameter of its parent path "%s"', a.path, e, t.props.path);
                  }), a.name) {
                    var l = s[a.name];
                    r(!l || e === l, 'You cannot use the name "%s" for more than one route', a.name), s[a.name] = e;
                  }
                  return a.catchAll ? (r(t, "<NotFoundRoute> must have a parent <Route>"), r(null == t.props.notFoundRoute, "You may not have more than one <NotFoundRoute> per <Route>"), t.props.notFoundRoute = e, null) : a.isDefault ? (r(t, "<DefaultRoute> must have a parent <Route>"), r(null == t.props.defaultRoute, "You may not have more than one <DefaultRoute> per <Route>"), t.props.defaultRoute = e, null) : (a.children = o.registerChildren(a.children, e), e);
                },
                registerChildren: function(e, t) {
                  var r = [];
                  return n.Children.forEach(e, function(e) {
                    (e = o.registerRoute(e, t)) && r.push(e);
                  }), r;
                },
                getRouteByName: function(e) {
                  return s[e] || null;
                }
              };
          t.exports = o;
        }, {
          "../utils/Path": 20,
          "react/lib/invariant": 42,
          "react/lib/warning": 48
        }],
        20: [function(e, t) {
          function n(e) {
            return encodeURIComponent(e).replace(/%20/g, "+");
          }
          function r(e) {
            return decodeURIComponent(e.replace(/\+/g, " "));
          }
          function i(e) {
            return String(e).split("/").map(n).join("/");
          }
          function s(e) {
            if (!(e in h)) {
              var t = [],
                  n = e.replace(u, function(e, n) {
                    return n ? (t.push(n), "([^./?#]+)") : "*" === e ? (t.push("splat"), "(.*?)") : "\\" + e;
                  });
              h[e] = {
                matcher: new RegExp("^" + n + "$", "i"),
                paramNames: t
              };
            }
            return h[e];
          }
          var o = e("react/lib/invariant"),
              a = e("qs/lib/utils").merge,
              c = e("qs"),
              u = /:([a-zA-Z_$][a-zA-Z0-9_$]*)|[*.()\[\]\\+|{}^$]/g,
              l = /\?(.+)/,
              h = {},
              p = {
                extractParamNames: function(e) {
                  return s(e).paramNames;
                },
                extractParams: function(e, t) {
                  var n = s(e),
                      i = r(t).match(n.matcher);
                  if (!i)
                    return null;
                  var o = {};
                  return n.paramNames.forEach(function(e, t) {
                    o[e] = i[t + 1];
                  }), o;
                },
                injectParams: function(e, t) {
                  t = t || {};
                  var n = 0;
                  return e.replace(u, function(r, s) {
                    s = s || "splat", o(null != t[s], 'Missing "' + s + '" parameter for path "' + e + '"');
                    var a;
                    return "splat" === s && Array.isArray(t[s]) ? (a = t[s][n++], o(null != a, "Missing splat # " + n + ' for path "' + e + '"')) : a = t[s], i(a);
                  });
                },
                extractQuery: function(e) {
                  var t = r(e).match(l);
                  return t && c.parse(t[1]);
                },
                withoutQuery: function(e) {
                  return e.replace(l, "");
                },
                withQuery: function(e, t) {
                  var n = p.extractQuery(e);
                  n && (t = t ? a(n, t) : n);
                  var r = t && c.stringify(t);
                  return r ? p.withoutQuery(e) + "?" + r : e;
                },
                isAbsolute: function(e) {
                  return "/" === e.charAt(0);
                },
                normalize: function(e) {
                  return e.replace(/^\/*/, "/");
                },
                join: function(e, t) {
                  return e.replace(/\/*$/, "/") + t;
                }
              };
          t.exports = p;
        }, {
          qs: 34,
          "qs/lib/utils": 38,
          "react/lib/invariant": 42
        }],
        21: [function(e, t) {
          function n(e, t, n) {
            this.to = e, this.params = t, this.query = n;
          }
          t.exports = n;
        }, {}],
        22: [function(e, t) {
          function n(e) {
            this.path = e, this.abortReason = null, this.isAborted = !1;
          }
          var r = e("react/lib/mixInto"),
              i = e("../actions/LocationActions").transitionTo,
              s = e("./Redirect");
          r(n, {
            abort: function(e) {
              this.abortReason = e, this.isAborted = !0;
            },
            redirect: function(e, t, n) {
              this.abort(new s(e, t, n));
            },
            retry: function() {
              i(this.path);
            }
          }), t.exports = n;
        }, {
          "../actions/LocationActions": 1,
          "./Redirect": 21,
          "react/lib/mixInto": 47
        }],
        23: [function(e, t) {
          function n() {
            return window.location.pathname + window.location.search;
          }
          t.exports = n;
        }, {}],
        24: [function(e, t) {
          t.exports = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
        }, {}],
        25: [function(e, t) {
          function n(e, t, n) {
            var o = s(e, t, n);
            return i.getLocation() === r ? "#" + o : o;
          }
          var r = e("../locations/HashLocation"),
              i = e("../stores/PathStore"),
              s = e("./makePath");
          t.exports = n;
        }, {
          "../locations/HashLocation": 11,
          "../stores/PathStore": 18,
          "./makePath": 26
        }],
        26: [function(e, t) {
          function n(e, t, n) {
            var o;
            if (s.isAbsolute(e))
              o = s.normalize(e);
            else {
              var a = i.getRouteByName(e);
              r(a, 'Unable to find a route named "' + e + '". Make sure you have a <Route name="' + e + '"> defined somewhere in your routes'), o = a.props.path;
            }
            return s.withQuery(s.injectParams(o, t), n);
          }
          var r = e("react/lib/invariant"),
              i = e("../stores/RouteStore"),
              s = e("./Path");
          t.exports = n;
        }, {
          "../stores/RouteStore": 19,
          "./Path": 20,
          "react/lib/invariant": 42
        }],
        27: [function(e, t) {
          function n(e, t) {
            if (null == e)
              return r.resolve();
            var n = Object.keys(e);
            return r.all(n.map(function(n) {
              return r.resolve(e[n]).then(function(e) {
                var r = {};
                r[n] = e, t(r);
              });
            }));
          }
          var r = e("when/lib/Promise");
          t.exports = n;
        }, {"when/lib/Promise": 49}],
        28: [function(e, t) {
          function n() {
            var e = navigator.userAgent;
            return -1 === e.indexOf("Android 2.") && -1 === e.indexOf("Android 4.0") || -1 === e.indexOf("Mobile Safari") || -1 !== e.indexOf("Chrome") ? window.history && "pushState" in window.history : !1;
          }
          t.exports = n;
        }, {}],
        29: [function(e, t) {
          function n(e, t) {
            var n = {};
            for (var r in e)
              e.hasOwnProperty(r) && !t[r] && (n[r] = e[r]);
            return n;
          }
          t.exports = n;
        }, {}],
        30: [function(e, t) {
          function n() {
            this._events = this._events || {}, this._maxListeners = this._maxListeners || void 0;
          }
          function r(e) {
            return "function" == typeof e;
          }
          function i(e) {
            return "number" == typeof e;
          }
          function s(e) {
            return "object" == typeof e && null !== e;
          }
          function o(e) {
            return void 0 === e;
          }
          t.exports = n, n.EventEmitter = n, n.prototype._events = void 0, n.prototype._maxListeners = void 0, n.defaultMaxListeners = 10, n.prototype.setMaxListeners = function(e) {
            if (!i(e) || 0 > e || isNaN(e))
              throw TypeError("n must be a positive number");
            return this._maxListeners = e, this;
          }, n.prototype.emit = function(e) {
            var t,
                n,
                i,
                a,
                c,
                u;
            if (this._events || (this._events = {}), "error" === e && (!this._events.error || s(this._events.error) && !this._events.error.length))
              throw t = arguments[1], t instanceof Error ? t : TypeError('Uncaught, unspecified "error" event.');
            if (n = this._events[e], o(n))
              return !1;
            if (r(n))
              switch (arguments.length) {
                case 1:
                  n.call(this);
                  break;
                case 2:
                  n.call(this, arguments[1]);
                  break;
                case 3:
                  n.call(this, arguments[1], arguments[2]);
                  break;
                default:
                  for (i = arguments.length, a = new Array(i - 1), c = 1; i > c; c++)
                    a[c - 1] = arguments[c];
                  n.apply(this, a);
              }
            else if (s(n)) {
              for (i = arguments.length, a = new Array(i - 1), c = 1; i > c; c++)
                a[c - 1] = arguments[c];
              for (u = n.slice(), i = u.length, c = 0; i > c; c++)
                u[c].apply(this, a);
            }
            return !0;
          }, n.prototype.addListener = function(e, t) {
            var i;
            if (!r(t))
              throw TypeError("listener must be a function");
            if (this._events || (this._events = {}), this._events.newListener && this.emit("newListener", e, r(t.listener) ? t.listener : t), this._events[e] ? s(this._events[e]) ? this._events[e].push(t) : this._events[e] = [this._events[e], t] : this._events[e] = t, s(this._events[e]) && !this._events[e].warned) {
              var i;
              i = o(this._maxListeners) ? n.defaultMaxListeners : this._maxListeners, i && i > 0 && this._events[e].length > i && (this._events[e].warned = !0, console.error("(node) warning: possible EventEmitter memory leak detected. %d listeners added. Use emitter.setMaxListeners() to increase limit.", this._events[e].length), "function" == typeof console.trace && console.trace());
            }
            return this;
          }, n.prototype.on = n.prototype.addListener, n.prototype.once = function(e, t) {
            function n() {
              this.removeListener(e, n), i || (i = !0, t.apply(this, arguments));
            }
            if (!r(t))
              throw TypeError("listener must be a function");
            var i = !1;
            return n.listener = t, this.on(e, n), this;
          }, n.prototype.removeListener = function(e, t) {
            var n,
                i,
                o,
                a;
            if (!r(t))
              throw TypeError("listener must be a function");
            if (!this._events || !this._events[e])
              return this;
            if (n = this._events[e], o = n.length, i = -1, n === t || r(n.listener) && n.listener === t)
              delete this._events[e], this._events.removeListener && this.emit("removeListener", e, t);
            else if (s(n)) {
              for (a = o; a-- > 0; )
                if (n[a] === t || n[a].listener && n[a].listener === t) {
                  i = a;
                  break;
                }
              if (0 > i)
                return this;
              1 === n.length ? (n.length = 0, delete this._events[e]) : n.splice(i, 1), this._events.removeListener && this.emit("removeListener", e, t);
            }
            return this;
          }, n.prototype.removeAllListeners = function(e) {
            var t,
                n;
            if (!this._events)
              return this;
            if (!this._events.removeListener)
              return 0 === arguments.length ? this._events = {} : this._events[e] && delete this._events[e], this;
            if (0 === arguments.length) {
              for (t in this._events)
                "removeListener" !== t && this.removeAllListeners(t);
              return this.removeAllListeners("removeListener"), this._events = {}, this;
            }
            if (n = this._events[e], r(n))
              this.removeListener(e, n);
            else
              for (; n.length; )
                this.removeListener(e, n[n.length - 1]);
            return delete this._events[e], this;
          }, n.prototype.listeners = function(e) {
            var t;
            return t = this._events && this._events[e] ? r(this._events[e]) ? [this._events[e]] : this._events[e].slice() : [];
          }, n.listenerCount = function(e, t) {
            var n;
            return n = e._events && e._events[t] ? r(e._events[t]) ? 1 : e._events[t].length : 0;
          };
        }, {}],
        31: [function(e, t) {
          t.exports.Dispatcher = e("./lib/Dispatcher");
        }, {"./lib/Dispatcher": 32}],
        32: [function(e, t) {
          function n() {
            "use strict";
            this.$Dispatcher_callbacks = {}, this.$Dispatcher_isPending = {}, this.$Dispatcher_isHandled = {}, this.$Dispatcher_isDispatching = !1, this.$Dispatcher_pendingPayload = null;
          }
          var r = e("./invariant"),
              i = 1,
              s = "ID_";
          n.prototype.register = function(e) {
            "use strict";
            var t = s + i++;
            return this.$Dispatcher_callbacks[t] = e, t;
          }, n.prototype.unregister = function(e) {
            "use strict";
            r(this.$Dispatcher_callbacks[e], "Dispatcher.unregister(...): `%s` does not map to a registered callback.", e), delete this.$Dispatcher_callbacks[e];
          }, n.prototype.waitFor = function(e) {
            "use strict";
            r(this.$Dispatcher_isDispatching, "Dispatcher.waitFor(...): Must be invoked while dispatching.");
            for (var t = 0; t < e.length; t++) {
              var n = e[t];
              this.$Dispatcher_isPending[n] ? r(this.$Dispatcher_isHandled[n], "Dispatcher.waitFor(...): Circular dependency detected while waiting for `%s`.", n) : (r(this.$Dispatcher_callbacks[n], "Dispatcher.waitFor(...): `%s` does not map to a registered callback.", n), this.$Dispatcher_invokeCallback(n));
            }
          }, n.prototype.dispatch = function(e) {
            "use strict";
            r(!this.$Dispatcher_isDispatching, "Dispatch.dispatch(...): Cannot dispatch in the middle of a dispatch."), this.$Dispatcher_startDispatching(e);
            try {
              for (var t in this.$Dispatcher_callbacks)
                this.$Dispatcher_isPending[t] || this.$Dispatcher_invokeCallback(t);
            } finally {
              this.$Dispatcher_stopDispatching();
            }
          }, n.prototype.isDispatching = function() {
            "use strict";
            return this.$Dispatcher_isDispatching;
          }, n.prototype.$Dispatcher_invokeCallback = function(e) {
            "use strict";
            this.$Dispatcher_isPending[e] = !0, this.$Dispatcher_callbacks[e](this.$Dispatcher_pendingPayload), this.$Dispatcher_isHandled[e] = !0;
          }, n.prototype.$Dispatcher_startDispatching = function(e) {
            "use strict";
            for (var t in this.$Dispatcher_callbacks)
              this.$Dispatcher_isPending[t] = !1, this.$Dispatcher_isHandled[t] = !1;
            this.$Dispatcher_pendingPayload = e, this.$Dispatcher_isDispatching = !0;
          }, n.prototype.$Dispatcher_stopDispatching = function() {
            "use strict";
            this.$Dispatcher_pendingPayload = null, this.$Dispatcher_isDispatching = !1;
          }, t.exports = n;
        }, {"./invariant": 33}],
        33: [function(e, t) {
          "use strict";
          var n = function(e, t, n, r, i, s, o, a) {
            if (!e) {
              var c;
              if (void 0 === t)
                c = new Error("Minified exception occurred; use the non-minified dev environment for the full error message and additional helpful warnings.");
              else {
                var u = [n, r, i, s, o, a],
                    l = 0;
                c = new Error("Invariant Violation: " + t.replace(/%s/g, function() {
                  return u[l++];
                }));
              }
              throw c.framesToPop = 1, c;
            }
          };
          t.exports = n;
        }, {}],
        34: [function(e, t) {
          t.exports = e("./lib");
        }, {"./lib": 35}],
        35: [function(e, t) {
          var n = e("./stringify"),
              r = e("./parse");
          t.exports = {
            stringify: n,
            parse: r
          };
        }, {
          "./parse": 36,
          "./stringify": 37
        }],
        36: [function(e, t) {
          var n = e("./utils"),
              r = {
                delimiter: "&",
                depth: 5,
                arrayLimit: 20,
                parameterLimit: 1e3
              };
          r.parseValues = function(e, t) {
            for (var r = {},
                i = e.split(t.delimiter, 1 / 0 === t.parameterLimit ? void 0 : t.parameterLimit),
                s = 0,
                o = i.length; o > s; ++s) {
              var a = i[s],
                  c = -1 === a.indexOf("]=") ? a.indexOf("=") : a.indexOf("]=") + 1;
              if (-1 === c)
                r[n.decode(a)] = "";
              else {
                var u = n.decode(a.slice(0, c)),
                    l = n.decode(a.slice(c + 1));
                r[u] = r[u] ? [].concat(r[u]).concat(l) : l;
              }
            }
            return r;
          }, r.parseObject = function(e, t, n) {
            if (!e.length)
              return t;
            var i = e.shift(),
                s = {};
            if ("[]" === i)
              s = [], s = s.concat(r.parseObject(e, t, n));
            else {
              var o = "[" === i[0] && "]" === i[i.length - 1] ? i.slice(1, i.length - 1) : i,
                  a = parseInt(o, 10);
              !isNaN(a) && i !== o && a <= n.arrayLimit ? (s = [], s[a] = r.parseObject(e, t, n)) : s[o] = r.parseObject(e, t, n);
            }
            return s;
          }, r.parseKeys = function(e, t, n) {
            if (e) {
              var i = /^([^\[\]]*)/,
                  s = /(\[[^\[\]]*\])/g,
                  o = i.exec(e);
              if (!Object.prototype.hasOwnProperty(o[1])) {
                var a = [];
                o[1] && a.push(o[1]);
                for (var c = 0; null !== (o = s.exec(e)) && c < n.depth; )
                  ++c, Object.prototype.hasOwnProperty(o[1].replace(/\[|\]/g, "")) || a.push(o[1]);
                return o && a.push("[" + e.slice(o.index) + "]"), r.parseObject(a, t, n);
              }
            }
          }, t.exports = function(e, t) {
            if ("" === e || null === e || "undefined" == typeof e)
              return {};
            t = t || {}, t.delimiter = "string" == typeof t.delimiter || n.isRegExp(t.delimiter) ? t.delimiter : r.delimiter, t.depth = "number" == typeof t.depth ? t.depth : r.depth, t.arrayLimit = "number" == typeof t.arrayLimit ? t.arrayLimit : r.arrayLimit, t.parameterLimit = "number" == typeof t.parameterLimit ? t.parameterLimit : r.parameterLimit;
            for (var i = "string" == typeof e ? r.parseValues(e, t) : e,
                s = {},
                o = Object.keys(i),
                a = 0,
                c = o.length; c > a; ++a) {
              var u = o[a],
                  l = r.parseKeys(u, i[u], t);
              s = n.merge(s, l);
            }
            return n.compact(s);
          };
        }, {"./utils": 38}],
        37: [function(e, t) {
          var n = e("./utils"),
              r = {delimiter: "&"};
          r.stringify = function(e, t) {
            if (n.isBuffer(e) ? e = e.toString() : e instanceof Date ? e = e.toISOString() : null === e && (e = ""), "string" == typeof e || "number" == typeof e || "boolean" == typeof e)
              return [encodeURIComponent(t) + "=" + encodeURIComponent(e)];
            var i = [];
            for (var s in e)
              e.hasOwnProperty(s) && (i = i.concat(r.stringify(e[s], t + "[" + s + "]")));
            return i;
          }, t.exports = function(e, t) {
            t = t || {};
            var n = "undefined" == typeof t.delimiter ? r.delimiter : t.delimiter,
                i = [];
            for (var s in e)
              e.hasOwnProperty(s) && (i = i.concat(r.stringify(e[s], s)));
            return i.join(n);
          };
        }, {"./utils": 38}],
        38: [function(e, t, n) {
          n.arrayToObject = function(e) {
            for (var t = {},
                n = 0,
                r = e.length; r > n; ++n)
              "undefined" != typeof e[n] && (t[n] = e[n]);
            return t;
          }, n.merge = function(e, t) {
            if (!t)
              return e;
            if (Array.isArray(t)) {
              for (var r = 0,
                  i = t.length; i > r; ++r)
                "undefined" != typeof t[r] && (e[r] = "object" == typeof e[r] ? n.merge(e[r], t[r]) : t[r]);
              return e;
            }
            if (Array.isArray(e)) {
              if ("object" != typeof t)
                return e.push(t), e;
              e = n.arrayToObject(e);
            }
            for (var s = Object.keys(t),
                o = 0,
                a = s.length; a > o; ++o) {
              var c = s[o],
                  u = t[c];
              e[c] = u && "object" == typeof u && e[c] ? n.merge(e[c], u) : u;
            }
            return e;
          }, n.decode = function(e) {
            try {
              return decodeURIComponent(e.replace(/\+/g, " "));
            } catch (t) {
              return e;
            }
          }, n.compact = function(e, t) {
            if ("object" != typeof e || null === e)
              return e;
            t = t || [];
            var r = t.indexOf(e);
            if (-1 !== r)
              return t[r];
            if (t.push(e), Array.isArray(e)) {
              for (var i = [],
                  s = 0,
                  o = e.length; o > s; ++s)
                "undefined" != typeof e[s] && i.push(e[s]);
              return i;
            }
            for (var a = Object.keys(e),
                s = 0,
                c = a.length; c > s; ++s) {
              var u = a[s];
              e[u] = n.compact(e[u], t);
            }
            return e;
          }, n.isRegExp = function(e) {
            return "[object RegExp]" === Object.prototype.toString.call(e);
          }, n.isBuffer = function(e) {
            return "undefined" != typeof Buffer ? Buffer.isBuffer(e) : !1;
          };
        }, {}],
        39: [function(e, t) {
          "use strict";
          var n = !("undefined" == typeof window || !window.document || !window.document.createElement),
              r = {
                canUseDOM: n,
                canUseWorkers: "undefined" != typeof Worker,
                canUseEventListeners: n && !(!window.addEventListener && !window.attachEvent),
                canUseViewport: n && !!window.screen,
                isInWorker: !n
              };
          t.exports = r;
        }, {}],
        40: [function(e, t) {
          function n(e, t, n, r, i, s, o) {
            e = e || {};
            for (var a,
                c = [t, n, r, i, s],
                u = 0; c[u]; ) {
              a = c[u++];
              for (var l in a)
                e[l] = a[l];
              a.hasOwnProperty && a.hasOwnProperty("toString") && "undefined" != typeof a.toString && e.toString !== a.toString && (e.toString = a.toString);
            }
            return e;
          }
          t.exports = n;
        }, {}],
        41: [function(e, t) {
          function n(e) {
            return function() {
              return e;
            };
          }
          function r() {}
          var i = e("./copyProperties");
          i(r, {
            thatReturns: n,
            thatReturnsFalse: n(!1),
            thatReturnsTrue: n(!0),
            thatReturnsNull: n(null),
            thatReturnsThis: function() {
              return this;
            },
            thatReturnsArgument: function(e) {
              return e;
            }
          }), t.exports = r;
        }, {"./copyProperties": 40}],
        42: [function(e, t) {
          "use strict";
          var n = function(e, t, n, r, i, s, o, a) {
            if (!e) {
              var c;
              if (void 0 === t)
                c = new Error("Minified exception occurred; use the non-minified dev environment for the full error message and additional helpful warnings.");
              else {
                var u = [n, r, i, s, o, a],
                    l = 0;
                c = new Error("Invariant Violation: " + t.replace(/%s/g, function() {
                  return u[l++];
                }));
              }
              throw c.framesToPop = 1, c;
            }
          };
          t.exports = n;
        }, {}],
        43: [function(e, t) {
          "use strict";
          var n = e("./invariant"),
              r = function(e) {
                var t,
                    r = {};
                n(e instanceof Object && !Array.isArray(e));
                for (t in e)
                  e.hasOwnProperty(t) && (r[t] = t);
                return r;
              };
          t.exports = r;
        }, {"./invariant": 42}],
        44: [function(e, t) {
          "use strict";
          var n = e("./mergeInto"),
              r = function(e, t) {
                var r = {};
                return n(r, e), n(r, t), r;
              };
          t.exports = r;
        }, {"./mergeInto": 46}],
        45: [function(e, t) {
          "use strict";
          var n = e("./invariant"),
              r = e("./keyMirror"),
              i = 36,
              s = function(e) {
                return "object" != typeof e || null === e;
              },
              o = {
                MAX_MERGE_DEPTH: i,
                isTerminal: s,
                normalizeMergeArg: function(e) {
                  return void 0 === e || null === e ? {} : e;
                },
                checkMergeArrayArgs: function(e, t) {
                  n(Array.isArray(e) && Array.isArray(t));
                },
                checkMergeObjectArgs: function(e, t) {
                  o.checkMergeObjectArg(e), o.checkMergeObjectArg(t);
                },
                checkMergeObjectArg: function(e) {
                  n(!s(e) && !Array.isArray(e));
                },
                checkMergeIntoObjectArg: function(e) {
                  n(!(s(e) && "function" != typeof e || Array.isArray(e)));
                },
                checkMergeLevel: function(e) {
                  n(i > e);
                },
                checkArrayStrategy: function(e) {
                  n(void 0 === e || e in o.ArrayStrategies);
                },
                ArrayStrategies: r({
                  Clobber: !0,
                  IndexByIndex: !0
                })
              };
          t.exports = o;
        }, {
          "./invariant": 42,
          "./keyMirror": 43
        }],
        46: [function(e, t) {
          "use strict";
          function n(e, t) {
            if (s(e), null != t) {
              i(t);
              for (var n in t)
                t.hasOwnProperty(n) && (e[n] = t[n]);
            }
          }
          var r = e("./mergeHelpers"),
              i = r.checkMergeObjectArg,
              s = r.checkMergeIntoObjectArg;
          t.exports = n;
        }, {"./mergeHelpers": 45}],
        47: [function(e, t) {
          "use strict";
          var n = function(e, t) {
            var n;
            for (n in t)
              t.hasOwnProperty(n) && (e.prototype[n] = t[n]);
          };
          t.exports = n;
        }, {}],
        48: [function(e, t) {
          "use strict";
          var n = e("./emptyFunction"),
              r = n;
          t.exports = r;
        }, {"./emptyFunction": 41}],
        49: [function(e, n) {
          !function(e) {
            "use strict";
            e(function(e) {
              var t = e("./makePromise"),
                  n = e("./Scheduler"),
                  r = e("./async");
              return t({scheduler: new n(r)});
            });
          }("function" == typeof t && t.amd ? t : function(t) {
            n.exports = t(e);
          });
        }, {
          "./Scheduler": 51,
          "./async": 52,
          "./makePromise": 53
        }],
        50: [function(e, n) {
          !function(e) {
            "use strict";
            e(function() {
              function e(e) {
                this.head = this.tail = this.length = 0, this.buffer = new Array(1 << e);
              }
              return e.prototype.push = function(e) {
                return this.length === this.buffer.length && this._ensureCapacity(2 * this.length), this.buffer[this.tail] = e, this.tail = this.tail + 1 & this.buffer.length - 1, ++this.length, this.length;
              }, e.prototype.shift = function() {
                var e = this.buffer[this.head];
                return this.buffer[this.head] = void 0, this.head = this.head + 1 & this.buffer.length - 1, --this.length, e;
              }, e.prototype._ensureCapacity = function(e) {
                var t,
                    n = this.head,
                    r = this.buffer,
                    i = new Array(e),
                    s = 0;
                if (0 === n)
                  for (t = this.length; t > s; ++s)
                    i[s] = r[s];
                else {
                  for (e = r.length, t = this.tail; e > n; ++s, ++n)
                    i[s] = r[n];
                  for (n = 0; t > n; ++s, ++n)
                    i[s] = r[n];
                }
                this.buffer = i, this.head = 0, this.tail = this.length;
              }, e;
            });
          }("function" == typeof t && t.amd ? t : function(e) {
            n.exports = e();
          });
        }, {}],
        51: [function(e, n) {
          !function(e) {
            "use strict";
            e(function(e) {
              function t(e) {
                this._async = e, this._queue = new r(15), this._afterQueue = new r(5), this._running = !1;
                var t = this;
                this.drain = function() {
                  t._drain();
                };
              }
              function n(e) {
                for (; e.length > 0; )
                  e.shift().run();
              }
              var r = e("./Queue");
              return t.prototype.enqueue = function(e) {
                this._add(this._queue, e);
              }, t.prototype.afterQueue = function(e) {
                this._add(this._afterQueue, e);
              }, t.prototype._drain = function() {
                n(this._queue), this._running = !1, n(this._afterQueue);
              }, t.prototype._add = function(e, t) {
                e.push(t), this._running || (this._running = !0, this._async(this.drain));
              }, t;
            });
          }("function" == typeof t && t.amd ? t : function(t) {
            n.exports = t(e);
          });
        }, {"./Queue": 50}],
        52: [function(n, r) {
          !function(t) {
            "use strict";
            t(function(t) {
              var n,
                  r;
              return n = "undefined" != typeof e && null !== e && "function" == typeof e.nextTick ? function(t) {
                e.nextTick(t);
              } : (r = "function" == typeof MutationObserver && MutationObserver || "function" == typeof WebKitMutationObserver && WebKitMutationObserver) ? function(e, t) {
                function n() {
                  var e = r;
                  r = void 0, e();
                }
                var r,
                    i = e.createElement("div"),
                    s = new t(n);
                return s.observe(i, {attributes: !0}), function(e) {
                  r = e, i.setAttribute("class", "x");
                };
              }(document, r) : function(e) {
                try {
                  return e("vertx").runOnLoop || e("vertx").runOnContext;
                } catch (t) {}
                var n = setTimeout;
                return function(e) {
                  n(e, 0);
                };
              }(t);
            });
          }("function" == typeof t && t.amd ? t : function(e) {
            r.exports = e(n);
          });
        }, {}],
        53: [function(e, n) {
          !function(e) {
            "use strict";
            e(function() {
              return function(e) {
                function t(e, t) {
                  this._handler = e === h ? t : n(e);
                }
                function n(e) {
                  function t(e) {
                    i.resolve(e);
                  }
                  function n(e) {
                    i.reject(e);
                  }
                  function r(e) {
                    i.notify(e);
                  }
                  var i = new f;
                  try {
                    e(t, n, r);
                  } catch (s) {
                    n(s);
                  }
                  return i;
                }
                function r(e) {
                  return k(e) ? e : new t(h, new d(u(e)));
                }
                function i(e) {
                  return new t(h, new d(new y(e)));
                }
                function s() {
                  return U;
                }
                function o() {
                  return new t(h, new f);
                }
                function a(e) {
                  function n(e, t, n) {
                    this[e] = t, 0 === --c && n.become(new m(this));
                  }
                  var r,
                      i,
                      s,
                      o,
                      a = new f,
                      c = e.length >>> 0,
                      u = new Array(c);
                  for (r = 0; r < e.length; ++r)
                    if (s = e[r], void 0 !== s || r in e)
                      if (A(s))
                        if (i = k(s) ? s._handler.join() : l(s), o = i.state(), 0 === o)
                          i.fold(n, r, u, a);
                        else {
                          if (!(o > 0)) {
                            a.become(i);
                            break;
                          }
                          u[r] = i.value, --c;
                        }
                      else
                        u[r] = s, --c;
                    else
                      --c;
                  return 0 === c && a.become(new m(u)), new t(h, a);
                }
                function c(e) {
                  if (Object(e) === e && 0 === e.length)
                    return s();
                  var n,
                      r,
                      i = new f;
                  for (n = 0; n < e.length; ++n)
                    r = e[n], void 0 !== r && n in e && u(r).visit(i, i.resolve, i.reject);
                  return new t(h, i);
                }
                function u(e) {
                  return k(e) ? e._handler.join() : A(e) ? l(e) : new m(e);
                }
                function l(e) {
                  try {
                    var t = e.then;
                    return "function" == typeof t ? new v(t, e) : new m(e);
                  } catch (n) {
                    return new y(n);
                  }
                }
                function h() {}
                function p() {}
                function f(e, n) {
                  t.createContext(this, n), this.consumers = void 0, this.receiver = e, this.handler = void 0, this.resolved = !1;
                }
                function d(e) {
                  this.handler = e;
                }
                function v(e, t) {
                  f.call(this), $.enqueue(new L(e, t, this));
                }
                function m(e) {
                  t.createContext(this), this.value = e;
                }
                function y(e) {
                  t.createContext(this), this.id = ++H, this.value = e, this.handled = !1, this.reported = !1, this._report();
                }
                function g(e, t) {
                  this.rejection = e, this.context = t;
                }
                function w(e) {
                  this.rejection = e;
                }
                function b() {
                  return new y(new TypeError("Promise cycle"));
                }
                function _(e, t) {
                  this.continuation = e, this.handler = t;
                }
                function E(e, t) {
                  this.handler = t, this.value = e;
                }
                function L(e, t, n) {
                  this._then = e, this.thenable = t, this.resolver = n;
                }
                function x(e, t, n, r, i) {
                  try {
                    e.call(t, n, r, i);
                  } catch (s) {
                    r(s);
                  }
                }
                function k(e) {
                  return e instanceof t;
                }
                function A(e) {
                  return ("object" == typeof e || "function" == typeof e) && null !== e;
                }
                function P(e, n, r, i) {
                  return "function" != typeof e ? i.become(n) : (t.enterContext(n), j(e, n.value, r, i), void t.exitContext());
                }
                function D(e, n, r, i, s) {
                  return "function" != typeof e ? s.become(r) : (t.enterContext(r), R(e, n, r.value, i, s), void t.exitContext());
                }
                function q(e, n, r, i, s) {
                  return "function" != typeof e ? s.notify(n) : (t.enterContext(r), C(e, n, i, s), void t.exitContext());
                }
                function j(e, t, n, r) {
                  try {
                    r.become(u(e.call(n, t)));
                  } catch (i) {
                    r.become(new y(i));
                  }
                }
                function R(e, t, n, r, i) {
                  try {
                    e.call(r, t, n, i);
                  } catch (s) {
                    i.become(new y(s));
                  }
                }
                function C(e, t, n, r) {
                  try {
                    r.notify(e.call(n, t));
                  } catch (i) {
                    r.notify(i);
                  }
                }
                function S(e, t) {
                  t.prototype = M(e.prototype), t.prototype.constructor = t;
                }
                function O() {}
                var $ = e.scheduler,
                    M = Object.create || function(e) {
                      function t() {}
                      return t.prototype = e, new t;
                    };
                t.resolve = r, t.reject = i, t.never = s, t._defer = o, t._handler = u, t.prototype.then = function(e, n) {
                  var r = this._handler;
                  if ("function" != typeof e && r.join().state() > 0)
                    return new t(h, r);
                  var i = this._beget(),
                      s = i._handler;
                  return r.chain(s, r.receiver, e, n, arguments.length > 2 ? arguments[2] : void 0), i;
                }, t.prototype["catch"] = function(e) {
                  return this.then(void 0, e);
                }, t.prototype._beget = function() {
                  var e = this._handler,
                      t = new f(e.receiver, e.join().context);
                  return new this.constructor(h, t);
                }, t.all = a, t.race = c, h.prototype.when = h.prototype.become = h.prototype.notify = h.prototype.fail = h.prototype._unreport = h.prototype._report = O, h.prototype._state = 0, h.prototype.state = function() {
                  return this._state;
                }, h.prototype.join = function() {
                  for (var e = this; void 0 !== e.handler; )
                    e = e.handler;
                  return e;
                }, h.prototype.chain = function(e, t, n, r, i) {
                  this.when({
                    resolver: e,
                    receiver: t,
                    fulfilled: n,
                    rejected: r,
                    progress: i
                  });
                }, h.prototype.visit = function(e, t, n, r) {
                  this.chain(T, e, t, n, r);
                }, h.prototype.fold = function(e, t, n, r) {
                  this.visit(r, function(r) {
                    e.call(n, t, r, this);
                  }, r.reject, r.notify);
                }, S(h, p), p.prototype.become = function(e) {
                  e.fail();
                };
                var T = new p;
                S(h, f), f.prototype._state = 0, f.prototype.resolve = function(e) {
                  this.become(u(e));
                }, f.prototype.reject = function(e) {
                  this.resolved || this.become(new y(e));
                }, f.prototype.join = function() {
                  if (!this.resolved)
                    return this;
                  for (var e = this; void 0 !== e.handler; )
                    if (e = e.handler, e === this)
                      return this.handler = b();
                  return e;
                }, f.prototype.run = function() {
                  var e = this.consumers,
                      t = this.join();
                  this.consumers = void 0;
                  for (var n = 0; n < e.length; ++n)
                    t.when(e[n]);
                }, f.prototype.become = function(e) {
                  this.resolved || (this.resolved = !0, this.handler = e, void 0 !== this.consumers && $.enqueue(this), void 0 !== this.context && e._report(this.context));
                }, f.prototype.when = function(e) {
                  this.resolved ? $.enqueue(new _(e, this.handler)) : void 0 === this.consumers ? this.consumers = [e] : this.consumers.push(e);
                }, f.prototype.notify = function(e) {
                  this.resolved || $.enqueue(new E(e, this));
                }, f.prototype.fail = function(e) {
                  var t = "undefined" == typeof e ? this.context : e;
                  this.resolved && this.handler.join().fail(t);
                }, f.prototype._report = function(e) {
                  this.resolved && this.handler.join()._report(e);
                }, f.prototype._unreport = function() {
                  this.resolved && this.handler.join()._unreport();
                }, S(h, d), d.prototype.when = function(e) {
                  $.enqueue(new _(e, this));
                }, d.prototype._report = function(e) {
                  this.join()._report(e);
                }, d.prototype._unreport = function() {
                  this.join()._unreport();
                }, S(f, v), S(h, m), m.prototype._state = 1, m.prototype.fold = function(e, t, n, r) {
                  D(e, t, this, n, r);
                }, m.prototype.when = function(e) {
                  P(e.fulfilled, this, e.receiver, e.resolver);
                };
                var H = 0;
                S(h, y), y.prototype._state = -1, y.prototype.fold = function(e, t, n, r) {
                  r.become(this);
                }, y.prototype.when = function(e) {
                  "function" == typeof e.rejected && this._unreport(), P(e.rejected, this, e.receiver, e.resolver);
                }, y.prototype._report = function(e) {
                  $.afterQueue(new g(this, e));
                }, y.prototype._unreport = function() {
                  this.handled = !0, $.afterQueue(new w(this));
                }, y.prototype.fail = function(e) {
                  t.onFatalRejection(this, void 0 === e ? this.context : e);
                }, g.prototype.run = function() {
                  this.rejection.handled || (this.rejection.reported = !0, t.onPotentiallyUnhandledRejection(this.rejection, this.context));
                }, w.prototype.run = function() {
                  this.rejection.reported && t.onPotentiallyUnhandledRejectionHandled(this.rejection);
                }, t.createContext = t.enterContext = t.exitContext = t.onPotentiallyUnhandledRejection = t.onPotentiallyUnhandledRejectionHandled = t.onFatalRejection = O;
                var N = new h,
                    U = new t(h, N);
                return _.prototype.run = function() {
                  this.handler.join().when(this.continuation);
                }, E.prototype.run = function() {
                  var e = this.handler.consumers;
                  if (void 0 !== e)
                    for (var t,
                        n = 0; n < e.length; ++n)
                      t = e[n], q(t.progress, this.value, this.handler, t.receiver, t.resolver);
                }, L.prototype.run = function() {
                  function e(e) {
                    r.resolve(e);
                  }
                  function t(e) {
                    r.reject(e);
                  }
                  function n(e) {
                    r.notify(e);
                  }
                  var r = this.resolver;
                  x(this._then, this.thenable, e, t, n);
                }, t;
              };
            });
          }("function" == typeof t && t.amd ? t : function(e) {
            n.exports = e();
          });
        }, {}]
      }, {}, [9])(9);
    });
  }(require("github:jspm/nodelibs@0.0.3/process"));
  
  global.define = __define;
  return module.exports;
});

System.register("npm:reflux@0.1.12", ["npm:reflux@0.1.12/dist/reflux"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/reflux@0.1.12.js";
  var __dirname = "jspm_packages/npm";
  module.exports = require("npm:reflux@0.1.12/dist/reflux");
  
  global.define = __define;
  return module.exports;
});

System.register("npm:es6-promise@1.0.0/dist/commonjs/promise/promise", ["npm:es6-promise@1.0.0/dist/commonjs/promise/config","npm:es6-promise@1.0.0/dist/commonjs/promise/config","npm:es6-promise@1.0.0/dist/commonjs/promise/utils","npm:es6-promise@1.0.0/dist/commonjs/promise/utils","npm:es6-promise@1.0.0/dist/commonjs/promise/utils","npm:es6-promise@1.0.0/dist/commonjs/promise/all","npm:es6-promise@1.0.0/dist/commonjs/promise/race","npm:es6-promise@1.0.0/dist/commonjs/promise/resolve","npm:es6-promise@1.0.0/dist/commonjs/promise/reject","npm:es6-promise@1.0.0/dist/commonjs/promise/asap"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise/promise.js";
  var __dirname = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/promise";
  "format cjs";
  "use strict";
  function Promise(e) {
    if (!isFunction(e))
      throw new TypeError("You must pass a resolver function as the first argument to the promise constructor");
    if (!(this instanceof Promise))
      throw new TypeError("Failed to construct 'Promise': Please use the 'new' operator, this object constructor cannot be called as a function.");
    this._subscribers = [], invokeResolver(e, this);
  }
  function invokeResolver(e, r) {
    function t(e) {
      resolve(r, e);
    }
    function i(e) {
      reject(r, e);
    }
    try {
      e(t, i);
    } catch (o) {
      i(o);
    }
  }
  function invokeCallback(e, r, t, i) {
    var o,
        n,
        s,
        c,
        l = isFunction(t);
    if (l)
      try {
        o = t(i), s = !0;
      } catch (u) {
        c = !0, n = u;
      }
    else
      o = i, s = !0;
    handleThenable(r, o) || (l && s ? resolve(r, o) : c ? reject(r, n) : e === FULFILLED ? resolve(r, o) : e === REJECTED && reject(r, o));
  }
  function subscribe(e, r, t, i) {
    var o = e._subscribers,
        n = o.length;
    o[n] = r, o[n + FULFILLED] = t, o[n + REJECTED] = i;
  }
  function publish(e, r) {
    for (var t,
        i,
        o = e._subscribers,
        n = e._detail,
        s = 0; s < o.length; s += 3)
      t = o[s], i = o[s + r], invokeCallback(r, t, i, n);
    e._subscribers = null;
  }
  function handleThenable(e, r) {
    var t,
        i = null;
    try {
      if (e === r)
        throw new TypeError("A promises callback cannot return that same promise.");
      if (objectOrFunction(r) && (i = r.then, isFunction(i)))
        return i.call(r, function(i) {
          return t ? !0 : (t = !0, void(r !== i ? resolve(e, i) : fulfill(e, i)));
        }, function(r) {
          return t ? !0 : (t = !0, void reject(e, r));
        }), !0;
    } catch (o) {
      return t ? !0 : (reject(e, o), !0);
    }
    return !1;
  }
  function resolve(e, r) {
    e === r ? fulfill(e, r) : handleThenable(e, r) || fulfill(e, r);
  }
  function fulfill(e, r) {
    e._state === PENDING && (e._state = SEALED, e._detail = r, config.async(publishFulfillment, e));
  }
  function reject(e, r) {
    e._state === PENDING && (e._state = SEALED, e._detail = r, config.async(publishRejection, e));
  }
  function publishFulfillment(e) {
    publish(e, e._state = FULFILLED);
  }
  function publishRejection(e) {
    publish(e, e._state = REJECTED);
  }
  var config = require("npm:es6-promise@1.0.0/dist/commonjs/promise/config").config,
      configure = require("npm:es6-promise@1.0.0/dist/commonjs/promise/config").configure,
      objectOrFunction = require("npm:es6-promise@1.0.0/dist/commonjs/promise/utils").objectOrFunction,
      isFunction = require("npm:es6-promise@1.0.0/dist/commonjs/promise/utils").isFunction,
      now = require("npm:es6-promise@1.0.0/dist/commonjs/promise/utils").now,
      all = require("npm:es6-promise@1.0.0/dist/commonjs/promise/all").all,
      race = require("npm:es6-promise@1.0.0/dist/commonjs/promise/race").race,
      staticResolve = require("npm:es6-promise@1.0.0/dist/commonjs/promise/resolve").resolve,
      staticReject = require("npm:es6-promise@1.0.0/dist/commonjs/promise/reject").reject,
      asap = require("npm:es6-promise@1.0.0/dist/commonjs/promise/asap").asap,
      counter = 0;
  config.async = asap;
  var PENDING = void 0,
      SEALED = 0,
      FULFILLED = 1,
      REJECTED = 2;
  Promise.prototype = {
    constructor: Promise,
    _state: void 0,
    _detail: void 0,
    _subscribers: void 0,
    then: function(e, r) {
      var t = this,
          i = new this.constructor(function() {});
      if (this._state) {
        var o = arguments;
        config.async(function() {
          invokeCallback(t._state, i, o[t._state - 1], t._detail);
        });
      } else
        subscribe(this, i, e, r);
      return i;
    },
    "catch": function(e) {
      return this.then(null, e);
    }
  }, Promise.all = all, Promise.race = race, Promise.resolve = staticResolve, Promise.reject = staticReject, exports.Promise = Promise;
  
  global.define = __define;
  return module.exports;
});

System.register("npm:sentence-case@1.1.0/sentence-case", ["npm:sentence-case@1.1.0/vendor/non-word-regexp","npm:sentence-case@1.1.0/vendor/camel-case-regexp","npm:sentence-case@1.1.0/vendor/trailing-digit-regexp"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/sentence-case@1.1.0/sentence-case.js";
  var __dirname = "jspm_packages/npm/sentence-case@1.1.0";
  "format cjs";
  var NON_WORD_REGEXP = require("npm:sentence-case@1.1.0/vendor/non-word-regexp"),
      CAMEL_CASE_REGEXP = require("npm:sentence-case@1.1.0/vendor/camel-case-regexp"),
      TRAILING_DIGIT_REGEXP = require("npm:sentence-case@1.1.0/vendor/trailing-digit-regexp");
  module.exports = function(e) {
    return null == e ? "" : String(e).replace(CAMEL_CASE_REGEXP, "$1 $2").replace(TRAILING_DIGIT_REGEXP, "$1 $2").replace(NON_WORD_REGEXP, " ").replace(/^ | $/g, "").toLowerCase();
  };
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/dataFiles/dataFileStore", ["npm:reflux@0.1.12","build/src/dataFiles/dataFileActions"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/dataFiles/dataFileStore.js";
  var __dirname = "build/src/dataFiles";
  var Reflux = require("npm:reflux@0.1.12");
  var dataFileActions = require("build/src/dataFiles/dataFileActions");
  module.exports = Reflux.createStore({
    listenables: dataFileActions,
    init: function() {
      this.dataFiles = {};
    },
    onAdd: function(dataFiles) {
      for (var i = 0; i < dataFiles.length; i++) {
        this.dataFiles[dataFiles[i].id] = dataFiles[i];
      }
      this.trigger(this.dataFiles);
    }
  });
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/components/ComparisonResults", ["github:reactjs/react-bower@0.11.2","npm:reflux@0.1.12","build/src/compare/compareStore","build/src/dataFiles/dataFileStore"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/components/ComparisonResults.js";
  var __dirname = "build/src/components";
  var React = require("github:reactjs/react-bower@0.11.2");
  var Reflux = require("npm:reflux@0.1.12");
  var compareStore = require("build/src/compare/compareStore");
  var dataFileStore = require("build/src/dataFiles/dataFileStore");
  var ComparisonResults = module.exports = React.createClass({
    displayName: 'ComparisonResults',
    mixins: [Reflux.connect(dataFileStore, 'dataFiles'), Reflux.connect(compareStore, 'discrepancies')],
    getInitialState: function() {
      return {
        dataFiles: {},
        discrepancies: {}
      };
    },
    render: function() {
      var self = this;
      var dataFileKeys = Object.keys(this.state.discrepancies);
      if (!dataFileKeys.length) {
        return null;
      }
      function getDiscrepancyRows(dataFileId) {
        var rowNodes = [];
        Object.keys(self.state.discrepancies[dataFileId]).forEach(function(key) {
          var cols = self.state.discrepancies[dataFileId][key].map(function(val) {
            return React.DOM.td(null, val);
          });
          rowNodes.push((React.DOM.tr({key: key}, React.DOM.td({className: "row-num"}, key), cols)));
        });
        return rowNodes;
      }
      var colClass = 'col col-1-' + dataFileKeys.length;
      var comparisonNodes = [];
      dataFileKeys.forEach(function(key) {
        comparisonNodes.push((React.DOM.div({
          className: colClass,
          key: key
        }, React.DOM.h2(null, self.state.dataFiles[key].filename), React.DOM.table(null, getDiscrepancyRows(key)))));
      });
      return (React.DOM.div({className: "comparison-results row"}, comparisonNodes));
    }
  });
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/components/FileDrop", ["github:reactjs/react-bower@0.11.2","build/src/dataFiles/dataFileActions","build/src/dataFiles/dataFileService"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/components/FileDrop.js";
  var __dirname = "build/src/components";
  var React = require("github:reactjs/react-bower@0.11.2");
  var dataFileActions = require("build/src/dataFiles/dataFileActions");
  var dataFileService = require("build/src/dataFiles/dataFileService");
  var FileDrop = module.exports = React.createClass({
    displayName: 'FileDrop',
    getInitialState: function() {
      return {over: false};
    },
    dragOver: function(e) {
      e.stopPropagation();
      e.preventDefault();
      this.setState({over: true});
    },
    dragLeave: function(e) {
      this.setState({over: false});
    },
    drop: function(e) {
      e.stopPropagation();
      e.preventDefault();
      this.setState({over: false});
      var droppedFiles = e.target.files || e.dataTransfer.files;
      var onProgress = function(percentComplete) {
        console.log(percentComplete);
      };
      dataFileService.upload(droppedFiles, onProgress).then(function(dataFiles) {
        dataFileActions.add(dataFiles);
      }, function(error) {
        console.error(error);
      });
    },
    render: function() {
      var fileDropClass = 'target';
      if (this.state.over) {
        fileDropClass += ' over';
      }
      return (React.DOM.div({className: "file-upload"}, React.DOM.p({
        className: fileDropClass,
        onDragOver: this.dragOver,
        onDragLeave: this.dragLeave,
        onDrop: this.drop
      }, "Drop Files Here")));
    }
  });
  
  global.define = __define;
  return module.exports;
});

System.register("npm:react-router@0.7.0", ["npm:react-router@0.7.0/dist/react-router"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/react-router@0.7.0.js";
  var __dirname = "jspm_packages/npm";
  module.exports = require("npm:react-router@0.7.0/dist/react-router");
  
  global.define = __define;
  return module.exports;
});

System.register("npm:es6-promise@1.0.0/dist/commonjs/main", ["npm:es6-promise@1.0.0/dist/commonjs/promise/promise","npm:es6-promise@1.0.0/dist/commonjs/promise/polyfill"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs/main.js";
  var __dirname = "jspm_packages/npm/es6-promise@1.0.0/dist/commonjs";
  "format cjs";
  "use strict";
  var Promise = require("npm:es6-promise@1.0.0/dist/commonjs/promise/promise").Promise,
      polyfill = require("npm:es6-promise@1.0.0/dist/commonjs/promise/polyfill").polyfill;
  exports.Promise = Promise, exports.polyfill = polyfill;
  
  global.define = __define;
  return module.exports;
});

System.register("npm:sentence-case@1.1.0", ["npm:sentence-case@1.1.0/sentence-case"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/sentence-case@1.1.0.js";
  var __dirname = "jspm_packages/npm";
  module.exports = require("npm:sentence-case@1.1.0/sentence-case");
  
  global.define = __define;
  return module.exports;
});

System.register("npm:es6-promise@1.0.0", ["npm:es6-promise@1.0.0/dist/commonjs/main"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/es6-promise@1.0.0.js";
  var __dirname = "jspm_packages/npm";
  module.exports = require("npm:es6-promise@1.0.0/dist/commonjs/main");
  
  global.define = __define;
  return module.exports;
});

System.register("npm:camel-case@1.0.2/camel-case", ["npm:sentence-case@1.1.0"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/camel-case@1.0.2/camel-case.js";
  var __dirname = "jspm_packages/npm/camel-case@1.0.2";
  "format cjs";
  var sentence = require("npm:sentence-case@1.1.0");
  module.exports = function(e) {
    return sentence(e).replace(/(\d) (?=\d)/g, "$1_").replace(/ (\w)/g, function(e, n) {
      return n.toUpperCase();
    });
  };
  
  global.define = __define;
  return module.exports;
});

System.register("npm:camel-case@1.0.2", ["npm:camel-case@1.0.2/camel-case"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "jspm_packages/npm/camel-case@1.0.2.js";
  var __dirname = "jspm_packages/npm";
  module.exports = require("npm:camel-case@1.0.2/camel-case");
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/util", ["npm:camel-case@1.0.2"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/util.js";
  var __dirname = "build/src";
  var camelCase = require("npm:camel-case@1.0.2");
  var util = module.exports = {};
  util.camelCaseObject = function(obj) {
    if (obj instanceof Array || typeof obj !== 'object') {
      return obj;
    }
    var camelCasedObj = {};
    for (var key in obj) {
      if (obj.hasOwnProperty(key)) {
        camelCasedObj[camelCase(key)] = util.camelCaseObject(obj[key]);
      }
    }
    return camelCasedObj;
  };
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/services/transport", ["npm:es6-promise@1.0.0","build/src/util"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/services/transport.js";
  var __dirname = "build/src/services";
  var ES6Promise = require("npm:es6-promise@1.0.0").Promise;
  var util = require("build/src/util");
  var transport = module.exports = {};
  transport.send = function(url, method, data, progressCallback) {
    return new ES6Promise(function(resolve, reject) {
      try {
        var req = new XMLHttpRequest();
        req.open(method, url, true);
        if (typeof progressCallback !== 'undefined') {
          req.upload.onprogress = function(event) {
            if (event.lengthComputable) {
              var percentComplete = event.loaded / event.total;
              progressCallback(percentComplete);
            }
          };
        }
        req.onload = function() {
          if (req.status === 200) {
            resolve(transport.parseResponse(req.response));
          } else {
            reject(new Error(req.statusText));
          }
        };
        req.onerror = function() {
          reject(Error('Network error'));
        };
        req.send(data);
      } catch (e) {
        reject(e);
      }
    });
  };
  transport.parseResponse = function(response) {
    try {
      response = JSON.parse(response);
    } catch (e) {
      throw new Error('Could not parse response into JSON: ' + response);
    }
    return util.camelCaseObject(response);
  };
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/compare/compareService", ["npm:es6-promise@1.0.0","build/src/services/transport"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/compare/compareService.js";
  var __dirname = "build/src/compare";
  var ES6Promise = require("npm:es6-promise@1.0.0").Promise;
  var transport = require("build/src/services/transport");
  var DATA_FILE_COMPARISON_URL = '/files/csv/compare';
  var compareService = module.exports = {};
  compareService.runComparisonOn = function(dataFileIds) {
    return new ES6Promise(function(resolve, reject) {
      var url = DATA_FILE_COMPARISON_URL + '?';
      var queryStr = dataFileIds.map(function(id) {
        return 'id=' + id;
      }).join('&');
      url += queryStr;
      transport.send(url, 'get').then(function(response) {
        if (response && response.data && response.data.comparison) {
          resolve(response.data.comparison);
        } else {
          reject(response);
        }
      }, function(error) {
        console.error(error);
        reject(error);
      });
    });
  };
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/components/CompareButton", ["github:reactjs/react-bower@0.11.2","npm:reflux@0.1.12","build/src/compare/compareActions","build/src/compare/compareService","build/src/dataFiles/dataFileStore"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/components/CompareButton.js";
  var __dirname = "build/src/components";
  var React = require("github:reactjs/react-bower@0.11.2");
  var Reflux = require("npm:reflux@0.1.12");
  var compareActions = require("build/src/compare/compareActions");
  var compareService = require("build/src/compare/compareService");
  var dataFileStore = require("build/src/dataFiles/dataFileStore");
  var CompareButton = module.exports = React.createClass({
    displayName: 'CompareButton',
    mixins: [Reflux.ListenerMixin],
    getInitialState: function() {
      return {
        dataFileIds: [],
        comparisonInProgress: false
      };
    },
    componentDidMount: function() {
      this.listenTo(dataFileStore, this.onDataFileStoreUpdate);
    },
    onDataFileStoreUpdate: function(dataFiles) {
      this.setState({dataFileIds: Object.keys(dataFiles)});
    },
    handleClick: function() {
      var self = this;
      if (!this.state.dataFileIds.length) {
        return;
      }
      this.setState({comparisonInProgress: true});
      compareService.runComparisonOn(this.state.dataFileIds).then(function(results) {
        console.log(results);
        self.setState({comparisonInProgress: false});
        compareActions.setResults(results);
      });
    },
    render: function() {
      var btnDisabled = (!this.state.dataFileIds.length || this.state.comparisonInProgress);
      var btnText = this.state.comparisonInProgress ? 'Running comparison...' : 'Compare';
      var btnClass = 'btn primary';
      if (btnDisabled) {
        btnClass += ' disabled';
      }
      return (React.DOM.div({className: "compare-action"}, React.DOM.button({
        type: "button",
        className: btnClass,
        disabled: btnDisabled,
        onClick: this.handleClick
      }, btnText)));
    }
  });
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/components/Compare", ["github:reactjs/react-bower@0.11.2","build/src/components/CompareButton","build/src/components/ComparisonResults","build/src/components/DataFileList","build/src/components/DataFileUploadStatus","build/src/components/FileDrop"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/components/Compare.js";
  var __dirname = "build/src/components";
  var React = require("github:reactjs/react-bower@0.11.2");
  var CompareButton = require("build/src/components/CompareButton");
  var ComparisonResults = require("build/src/components/ComparisonResults");
  var DataFileList = require("build/src/components/DataFileList");
  var DataFileUploadStatus = require("build/src/components/DataFileUploadStatus");
  var FileDrop = require("build/src/components/FileDrop");
  var Compare = module.exports = React.createClass({
    displayName: 'Compare',
    render: function() {
      return (React.DOM.div({className: "compare"}, React.DOM.p({className: "lead"}, "Compare CSV files by dropping them onto the page below"), DataFileList(null), DataFileUploadStatus(null), CompareButton(null), ComparisonResults(null), FileDrop(null)));
    }
  });
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/components/AppRoutes", ["github:reactjs/react-bower@0.11.2","npm:react-router@0.7.0","npm:react-router@0.7.0","npm:react-router@0.7.0","npm:react-router@0.7.0","build/src/components/App","build/src/components/Compare","build/src/components/Main","build/src/components/NotFound"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/components/AppRoutes.js";
  var __dirname = "build/src/components";
  var React = require("github:reactjs/react-bower@0.11.2");
  var DefaultRoute = require("npm:react-router@0.7.0").DefaultRoute;
  var NotFoundRoute = require("npm:react-router@0.7.0").NotFoundRoute;
  var Route = require("npm:react-router@0.7.0").Route;
  var Routes = require("npm:react-router@0.7.0").Routes;
  var App = require("build/src/components/App");
  var Compare = require("build/src/components/Compare");
  var Main = require("build/src/components/Main");
  var NotFound = require("build/src/components/NotFound");
  var AppRoutes = module.exports = React.createClass({
    displayName: 'DataGroomerAppRoutes',
    render: function() {
      return (Routes({location: "history"}, Route({
        path: "/",
        handler: App
      }, DefaultRoute({handler: Main}), Route({
        name: "compare",
        handler: Compare
      })), NotFoundRoute({handler: NotFound})));
    }
  });
  
  global.define = __define;
  return module.exports;
});

System.register("build/src/dataGroomer", ["build/src/components/AppRoutes","github:reactjs/react-bower@0.11.2"], true, function(require, exports, module) {
  var global = System.global;
  var __define = global.define;
  global.define = undefined;
  var __filename = "build/src/dataGroomer.js";
  var __dirname = "build/src";
  var AppRoutes = require("build/src/components/AppRoutes");
  var React = require("github:reactjs/react-bower@0.11.2");
  (function init() {
    var mountNode = document.getElementById('app');
    React.renderComponent(new AppRoutes(null), mountNode);
  })();
  
  global.define = __define;
  return module.exports;
});

(function() {
  var loader = System;
  var hasOwnProperty = loader.global.hasOwnProperty;
  var moduleGlobals = {};
  var curGlobalObj;
  var ignoredGlobalProps;
  if (typeof indexOf == 'undefined')
    indexOf = Array.prototype.indexOf;
  System.set("@@global-helpers", System.newModule({
    prepareGlobal: function(moduleName, deps) {
      for (var i = 0; i < deps.length; i++) {
        var moduleGlobal = moduleGlobals[deps[i]];
        if (moduleGlobal)
          for (var m in moduleGlobal)
            loader.global[m] = moduleGlobal[m];
      }
      curGlobalObj = {};
      ignoredGlobalProps = ["indexedDB", "sessionStorage", "localStorage", "clipboardData", "frames", "webkitStorageInfo"];
      for (var g in loader.global) {
        if (indexOf.call(ignoredGlobalProps, g) != -1) { continue; }
        if (!hasOwnProperty || loader.global.hasOwnProperty(g)) {
          try {
            curGlobalObj[g] = loader.global[g];
          } catch (e) {
            ignoredGlobalProps.push(g);
          }
        }
      }
    },
    retrieveGlobal: function(moduleName, exportName, init) {
      var singleGlobal;
      var multipleExports;
      var exports = {};
      if (init) {
        var depModules = [];
        for (var i = 0; i < deps.length; i++)
          depModules.push(require(deps[i]));
        singleGlobal = init.apply(loader.global, depModules);
      }
      else if (exportName) {
        var firstPart = exportName.split(".")[0];
        singleGlobal = eval.call(loader.global, exportName);
        exports[firstPart] = loader.global[firstPart];
      }
      else {
        for (var g in loader.global) {
          if (indexOf.call(ignoredGlobalProps, g) != -1)
            continue;
          if ((!hasOwnProperty || loader.global.hasOwnProperty(g)) && g != loader.global && curGlobalObj[g] != loader.global[g]) {
            exports[g] = loader.global[g];
            if (singleGlobal) {
              if (singleGlobal !== loader.global[g])
                multipleExports = true;
            }
            else if (singleGlobal !== false) {
              singleGlobal = loader.global[g];
            }
          }
        }
      }
      moduleGlobals[moduleName] = exports;
      return multipleExports ? exports : singleGlobal;
    }
  }));
})();

});