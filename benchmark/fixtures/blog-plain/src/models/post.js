'use strict';
// No ORM here. The shape is declared explicitly so it is a contract rather than a guess —
// inferring a schema from sample rows is how you get a field that is a string in every row you
// looked at and a number in the one you didn't.
module.exports = {
  name: 'Post',
  fields: {
    id:        'number',
    slug:      'string',
    title:     'string',
    body:      'string',
    views:     'number',
    published: 'boolean',
    createdAt: 'date',
  },
};
