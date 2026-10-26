// A stand-in for PayPal's JS SDK, for PAYPAL_ENV=fake in local
// development (netlify/functions/lib/fake.mjs). It offers what the
// order page uses (assets/scripts/order/pay.js): one Venmo button that
// runs the page's onClick, createOrder and onApprove in order, as
// PayPal's does once the customer approves in the Venmo app, with no
// app and no popup. Published at /scripts/fake-paypal.js by a local
// `hugo server` only (layouts/partials/fake-sdks.html).

const Buttons = (options) => {
  let button = null;
  let disabled = false;

  const actions = {
    resolve: async () => true,
    reject: async () => false,
    enable: () => {
      disabled = false;
      if (button) button.disabled = false;
    },
    disable: () => {
      disabled = true;
      if (button) button.disabled = true;
    },
  };

  const run = async () => {
    if (disabled) return;

    const data = { fundingSource: "venmo" };

    try {
      if (options.onClick) {
        const go = await options.onClick(data, actions);

        if (go === false) return;
      }

      const orderID = await options.createOrder(data, actions);

      await options.onApprove({ ...data, orderID }, actions);
    } catch (error) {
      if (options.onError) options.onError(error);
    }
  };

  return {
    isEligible: () => true,
    render: async (container) => {
      const target = typeof container === "string"
        ? document.querySelector(container)
        : container;

      button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-primary w-100";
      button.dataset.fakeVenmo = "";
      button.textContent = "Venmo (fake)";
      button.disabled = disabled;
      button.addEventListener("click", run);
      target.replaceChildren(button);
      if (options.onInit) options.onInit({}, actions);
    },
  };
};

window.paypal = { Buttons, FUNDING: { VENMO: "venmo" } };
