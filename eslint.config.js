const js = require("@eslint/js");
const babelParser = require("@babel/eslint-parser");
const globals = require("globals");

module.exports = [
	js.configs.recommended,
	{
		files: ["**/*.js"],
		languageOptions: {
			parser: babelParser,
			parserOptions: {
				requireConfigFile: false
			},
			sourceType: "commonjs",
			globals: Object.assign({}, globals.node, globals.commonjs, globals.jest)
		},
		rules: {
			"indent": ["error", "tab"],
			"quotes": ["error", "double"],
			"semi": ["error", "always"],
			"no-param-reassign": "error",
			"no-trailing-spaces": "error",
			"no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
		}
	}
];
