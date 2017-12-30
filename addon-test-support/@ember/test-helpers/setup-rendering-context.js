import { guidFor } from '@ember/object/internals';
import { run } from '@ember/runloop';
import Ember from 'ember';
import global from './global';
import { getContext } from './setup-context';
import { nextTickPromise } from './-utils';
import settled from './settled';
import hbs from 'htmlbars-inline-precompile';

export const RENDERING_CLEANUP = Object.create(null);

/**
  Renders the provided template and appends it to the DOM.

  @public
  @param {CompiledTemplate} template the template to render
  @returns {Promise<void>} resolves when settled
*/
export function render(template) {
  let context = getContext();

  if (!context || typeof context.render !== 'function') {
    throw new Error('Cannot call `render` without having first called `setupRenderingContext`.');
  }

  return context.render(template);
}

/**
  Clears any templates previously rendered. This is commonly used for
  confirming behavior that is triggered by teardown (e.g.
  `willDestroyElement`).

  @public
  @returns {Promise<void>} resolves when settled
*/
export function clearRender() {
  let context = getContext();

  if (!context || typeof context.clearRender !== 'function') {
    throw new Error(
      'Cannot call `clearRender` without having first called `setupRenderingContext`.'
    );
  }

  return context.clearRender();
}

/**
  Used by test framework addons to setup the provided context for rendering.

  `setupContext` must have been ran on the provided context
  prior to calling `setupRenderingContext`.

  Responsible for:

  - Setup the basic framework used for rendering by the
    `render` helper.
  - Ensuring the event dispatcher is properly setup.
  - Setting `this.element` to the root element of the testing
    container (things rendered via `render` will go _into_ this
    element).

  @public
  @param {Object} context the context to setup for rendering
  @returns {Promise<Object>} resolves with the context that was setup
*/
export default function setupRenderingContext(context) {
  let contextGuid = guidFor(context);
  RENDERING_CLEANUP[contextGuid] = [];

  return nextTickPromise().then(() => {
    let { owner } = context;

    // When the host app uses `setApplication` (instead of `setResolver`) the event dispatcher has
    // already been setup via `applicationInstance.boot()` in `./build-owner`. If using
    // `setResolver` (instead of `setApplication`) a "mock owner" is created by extending
    // `Ember._ContainerProxyMixin` and `Ember._RegistryProxyMixin` in this scenario we need to
    // manually start the event dispatcher.
    if (owner._emberTestHelpersMockOwner) {
      let dispatcher = owner.lookup('event_dispatcher:main') || Ember.EventDispatcher.create();
      dispatcher.setup({}, '#ember-testing');
    }

    let OutletView = owner.factoryFor
      ? owner.factoryFor('view:-outlet')
      : owner._lookupFactory('view:-outlet');
    let toplevelView = OutletView.create();
    let OutletTemplate = owner.lookup('template:-outlet');
    if (!OutletTemplate) {
      owner.register('template:-outlet', hbs`{{outlet}}`);
      OutletTemplate = owner.lookup('template:-outlet');
    }

    // push this into the rendering specific cleanup bucket, to be ran during
    // `teardownRenderingContext` but before the owner itself is destroyed
    RENDERING_CLEANUP[contextGuid].push(() => toplevelView.destroy());

    let outletState = {
      render: {
        owner,
        into: undefined,
        outlet: 'main',
        name: 'application',
        controller: context,
        ViewClass: undefined,
        template: OutletTemplate,
      },

      outlets: {},
    };
    toplevelView.setOutletState(outletState);

    let rootElement;
    // When the host app uses `setApplication` (instead of `setResolver`) the owner has
    // a `rootElement` set on it with the element id to be used
    if (owner._emberTestHelpersMockOwner) {
      rootElement = '#ember-testing';
    } else {
      rootElement = owner.rootElement;
    }
    run(toplevelView, 'appendTo', rootElement);

    // ensure the element is based on the wrapping toplevel view
    // Ember still wraps the main application template with a
    // normal tagged view
    //
    // In older Ember versions (2.4) the element itself is not stable,
    // and therefore we cannot update the `this.element` until after the
    // rendering is completed
    context.element = document.querySelector('#ember-testing > .ember-view');

    let templateId = 0;

    context.render = function render(template) {
      if (!template) {
        throw new Error('you must pass a template to `render()`');
      }

      return nextTickPromise().then(() => {
        templateId += 1;
        let templateFullName = `template:-undertest-${templateId}`;
        owner.register(templateFullName, template);
        let stateToRender = {
          owner,
          into: undefined,
          outlet: 'main',
          name: 'index',
          controller: context,
          ViewClass: undefined,
          template: owner.lookup(templateFullName),
          outlets: {},
        };

        stateToRender.name = 'index';
        outletState.outlets.main = { render: stateToRender, outlets: {} };

        toplevelView.setOutletState(outletState);

        // using next here because the actual rendering does not happen until
        // the renderer detects it is dirty (which happens on backburner's end
        // hook), see the following implementation details:
        //
        // * [view:outlet](https://github.com/emberjs/ember.js/blob/f94a4b6aef5b41b96ef2e481f35e07608df01440/packages/ember-glimmer/lib/views/outlet.js#L129-L145) manually dirties its own tag upon `setOutletState`
        // * [backburner's custom end hook](https://github.com/emberjs/ember.js/blob/f94a4b6aef5b41b96ef2e481f35e07608df01440/packages/ember-glimmer/lib/renderer.js#L145-L159) detects that the current revision of the root is no longer the latest, and triggers a new rendering transaction
        return settled();
      });
    };

    if (global.jQuery) {
      context.$ = function $(selector) {
        // emulates Ember internal behavor of `this.$` in a component
        // https://github.com/emberjs/ember.js/blob/v2.5.1/packages/ember-views/lib/views/states/has_element.js#L18
        return selector ? global.jQuery(selector, context.element) : global.jQuery(context.element);
      };
    }

    context.clearRender = function clearRender() {
      return nextTickPromise().then(() => {
        toplevelView.setOutletState({
          render: {
            owner,
            into: undefined,
            outlet: 'main',
            name: 'application',
            controller: context,
            ViewClass: undefined,
            template: OutletTemplate,
          },
          outlets: {},
        });

        return settled();
      });
    };

    return context;
  });
}
