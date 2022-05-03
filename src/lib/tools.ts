/**
 * Tests whether the given variable is a real object and not an Array
 * @param it The variable to test
 * @returns true if it is Record<string, any>
 */
export function isObject(it: any): it is Record<string, any> {
    return Object.prototype.toString.call(it) === '[object Object]';
}
