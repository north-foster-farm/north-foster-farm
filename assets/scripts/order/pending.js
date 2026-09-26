// The notice shown while an order is being sent and no button of ours
// shows it: a wallet's or Venmo's payment.

export class Pending {
  constructor(el) {
    this.el = el;
  }

  sending() {
    this.el.hidden = false;
    this.el.dataset.pendingState = "sending";
  }

  hide() {
    this.el.hidden = true;
    delete this.el.dataset.pendingState;
  }
}
