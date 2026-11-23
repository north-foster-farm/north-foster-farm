// The shape of an order id the site draws, for the functions. The
// pattern lives in assets/scripts/utils/order-id.mjs, so the account
// page reads the same one (#947). Alone here so lib/store.mjs can know
// one in a key without loading the Square client.
export {
  ID_LENGTH,
  ID_TAIL,
  ORDER_ID,
} from "../../../assets/scripts/utils/order-id.mjs";
