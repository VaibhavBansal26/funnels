// The slice of the shared page model the settings editors use (one import site, so the web bundle only pulls what the builder needs).
export { CountdownPropsSchema, FormPropsSchema, ProductPropsSchema, VideoPropsSchema, parseVideoUrl, type FormProps, type ProductProps } from '@pagemodel';
export const CheckoutSchemaHint = 'The price shown to buyers and the amount charged always come from the product saved on the server. Editing the page cannot change what a buyer pays unless you save it.';
